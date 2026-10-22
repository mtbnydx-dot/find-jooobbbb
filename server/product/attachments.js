'use strict';

const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const services=new WeakMap();
const MAX_BYTES=5*1024*1024;
const MIME={'.txt':'text/plain; charset=utf-8','.pdf':'application/pdf','.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
function fail(message,statusCode=400,code='ATTACHMENT_INVALID'){const e=new Error(message);e.statusCode=statusCode;e.code=code;throw e;}
function safeComponent(value){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(String(value)))fail('文件标识无效');return String(value);}
class AttachmentService {
  constructor(platform) {
    this.platform=platform;this.db=platform.store.db;
    this.root=path.join(platform.store.dataDir,'private-attachments');
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    if(fs.lstatSync(this.root).isSymbolicLink())fail('附件存储目录不能是符号链接',500);
    this.db.exec(`CREATE TABLE IF NOT EXISTS user_attachments(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,name TEXT NOT NULL,extension TEXT NOT NULL,mime TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,parse_status TEXT NOT NULL,extracted_text TEXT NOT NULL DEFAULT '',text_truncated INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);CREATE INDEX IF NOT EXISTS attachments_user_idx ON user_attachments(user_id,created_at);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS attachment_cleanup_tasks(user_id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  }
  file(userId,id) {
    const folder=path.join(this.root,safeComponent(userId));
    if(fs.existsSync(folder)&&fs.lstatSync(folder).isSymbolicLink())fail('附件目录异常',500);
    const result=path.resolve(folder,`${safeComponent(id)}.bin`);
    if(!result.startsWith(path.resolve(this.root)+path.sep))fail('附件路径异常',500);
    if(fs.existsSync(result)&&fs.lstatSync(result).isSymbolicLink())fail('附件文件异常',500);
    return result;
  }
  item(row,includeText=false){return {id:row.id,name:row.name,mime:row.mime,size:row.size,sha256:row.sha256,parseStatus:row.parse_status,textTruncated:Boolean(row.text_truncated),createdAt:row.created_at,downloadPath:`/me/attachments/${row.id}/download`,parseMessage:row.parse_status==='parsed_text'?'已读取 TXT 文本，未进行 AI 分析':'仅私有保存并可下载；PDF/Word 文本解析尚未接入',...(includeText?{text:row.extracted_text}:{})};}
  list(user){return {attachments:this.db.prepare('SELECT * FROM user_attachments WHERE user_id=? ORDER BY created_at DESC,id').all(user.id).map(row=>this.item(row)),limits:{maxFileBytes:MAX_BYTES,maxFiles:20,maxTotalBytes:50*1024*1024,types:Object.keys(MIME)}};}
  get(user,id){const row=this.db.prepare('SELECT * FROM user_attachments WHERE id=? AND user_id=?').get(String(id),user.id);if(!row)fail('附件不存在',404,'NOT_FOUND');return row;}
  upload(user,input={}) {
    if(typeof input.name!=='string' || !input.name.trim() || input.name.length>180 || /[\0\r\n\\/]/.test(input.name))fail('文件名无效');
    const name=input.name.trim();const extension=path.extname(name).toLowerCase();
    if(!MIME[extension])fail('仅支持 TXT、PDF、DOC、DOCX');
    if(typeof input.contentBase64!=='string' || input.contentBase64.length>Math.ceil(MAX_BYTES/3)*4 || input.contentBase64.length%4 || /[^A-Za-z0-9+/=]/.test(input.contentBase64))fail('文件编码无效或超过 5 MB',413,'ATTACHMENT_TOO_LARGE');
    const bytes=Buffer.from(input.contentBase64,'base64');if(!bytes.length || bytes.length>MAX_BYTES)fail('文件不能为空或超过 5 MB',413,'ATTACHMENT_TOO_LARGE');
    if(bytes.toString('base64')!==input.contentBase64)fail('文件编码无效');
    let extracted='';
    if(extension==='.txt'){try{extracted=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{fail('TXT 必须使用 UTF-8 编码');}if(extracted.includes('\0'))fail('TXT 含无效二进制内容');}
    if(extension==='.pdf'&&bytes.subarray(0,5).toString()!=='%PDF-')fail('文件内容与 PDF 类型不符');
    if(extension==='.docx'&&!(bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===3&&bytes[3]===4))fail('文件内容与 DOCX 类型不符');
    if(extension==='.doc'&&bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')fail('文件内容与 DOC 类型不符');
    const sha=crypto.createHash('sha256').update(bytes).digest('hex');
    const existing=this.db.prepare('SELECT * FROM user_attachments WHERE user_id=? AND sha256=?').get(user.id,sha);if(existing)return {attachment:this.item(existing,true),duplicate:true};
    const id=crypto.randomUUID();const target=this.file(user.id,id);fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const usage=this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM user_attachments WHERE user_id=?').get(user.id);
      if(usage.count>=20||usage.bytes+bytes.length>50*1024*1024)fail('附件空间已满，请先整理旧附件',403,'ATTACHMENT_LIMIT');
      fs.writeFileSync(target,bytes,{flag:'wx',mode:0o600});
      this.db.prepare('INSERT INTO user_attachments(id,user_id,name,extension,mime,size,sha256,parse_status,extracted_text,text_truncated,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id,user.id,name,extension,MIME[extension],bytes.length,sha,extension==='.txt'?'parsed_text':'stored_only',extracted.slice(0,100000),Number(extracted.length>100000),new Date(this.platform.clock()).toISOString());
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');if(fs.existsSync(target))fs.unlinkSync(target);throw error;}
    return {attachment:this.item(this.get(user,id),true),duplicate:false};
  }
  remove(user,id) {
    const row=this.get(user,id);const target=this.file(user.id,row.id);
    // Delete the private bytes before the metadata, so failed disk removal is not reported as success.
    if(fs.existsSync(target))fs.unlinkSync(target);
    this.db.prepare('DELETE FROM user_attachments WHERE id=? AND user_id=?').run(row.id,user.id);return {deleted:true};
  }
  download(user,id) {const row=this.get(user,id);const target=this.file(user.id,row.id);if(!fs.existsSync(target))fail('附件文件暂不可用',404,'FILE_MISSING');return {row,target};}
  cleanupUser(userId) {
    const folder=path.join(this.root,safeComponent(userId));
    const now=new Date(this.platform.clock()).toISOString();
    this.db.prepare('INSERT OR IGNORE INTO attachment_cleanup_tasks(user_id,created_at,updated_at) VALUES(?,?,?)').run(userId,now,now);
    try {
      if(fs.existsSync(folder)) {
        if(fs.lstatSync(folder).isSymbolicLink())fail('附件目录异常',500);
        for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
          if(!entry.isFile() || !/^[a-zA-Z0-9_-]+\.bin$/.test(entry.name))fail('附件目录包含异常项目，需人工核对',500);
          fs.unlinkSync(this.file(userId,entry.name.slice(0,-4)));
        }
        fs.rmdirSync(folder);
      }
      this.db.prepare('DELETE FROM attachment_cleanup_tasks WHERE user_id=?').run(userId);
      return {complete:true};
    } catch(error) {
      this.db.prepare("UPDATE attachment_cleanup_tasks SET attempts=attempts+1,last_error='FILE_CLEANUP_FAILED',updated_at=? WHERE user_id=?").run(now,userId);
      throw error;
    }
  }
  cleanupStatus(){return {pending:Number(this.db.prepare('SELECT COUNT(*) AS n FROM attachment_cleanup_tasks').get().n)};}
  retryCleanup(){let completed=0,failed=0;for(const row of this.db.prepare('SELECT user_id FROM attachment_cleanup_tasks WHERE NOT EXISTS(SELECT 1 FROM users WHERE users.id=attachment_cleanup_tasks.user_id) ORDER BY updated_at LIMIT 20').all()){try{this.cleanupUser(row.user_id);completed++;}catch(_){failed++;}}return {completed,failed,...this.cleanupStatus()};}
}
function initializeAttachments(platform){if(!services.has(platform))services.set(platform,new AttachmentService(platform));return services.get(platform);}
function cleanupAttachmentUser(platform,userId){return initializeAttachments(platform).cleanupUser(userId);}
function registerAttachmentRoutes(router,{platform,requireAuth}) {
  const service=initializeAttachments(platform);const route=fn=>(req,res,next)=>{try{fn(req,res,next);}catch(error){next(error);}};
  router.get('/me/attachments',requireAuth,route((req,res)=>res.json({ok:true,...service.list(req.productUser)})));
  router.post('/me/attachments',requireAuth,route((req,res)=>res.status(201).json({ok:true,...service.upload(req.productUser,req.body)})));
  router.get('/me/attachments/:id',requireAuth,route((req,res)=>res.json({ok:true,attachment:service.item(service.get(req.productUser,req.params.id),true)})));
  router.delete('/me/attachments/:id',requireAuth,route((req,res)=>res.json({ok:true,...service.remove(req.productUser,req.params.id)})));
  router.get('/me/attachments/:id/download',requireAuth,route((req,res,next)=>{const {row,target}=service.download(req.productUser,req.params.id);res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});res.download(target,row.name,error=>{if(error&&!res.headersSent)next(error);});}));
  return service;
}
module.exports={MAX_BYTES,AttachmentService,initializeAttachments,cleanupAttachmentUser,registerAttachmentRoutes};
