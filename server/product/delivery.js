'use strict';

const crypto = require('node:crypto');
const { ProductCommerce } = require('./commerce');
const services = new WeakMap();
const fail = (message,statusCode=400,code='DELIVERY_INVALID') => { const e=new Error(message);e.statusCode=statusCode;e.code=code;throw e; };
const json = (value,fallback={})=>{try{return JSON.parse(value);}catch{return fallback;}};
const uuid = ()=>crypto.randomUUID();

class DeliveryService {
  constructor(platform, options={}) {
    this.platform=platform; this.db=platform.store.db; this.options=options;
    this.emailTransport=options.emailTransport || null; this.emailFrom=options.emailFrom || process.env.PRODUCT_SMTP_FROM || '';
    this.pushProvider=options.pushProvider || null;
    this.publicBaseUrl=options.publicBaseUrl || process.env.PRODUCT_PUBLIC_URL || '';
    if (!this.emailTransport && process.env.PRODUCT_SMTP_HOST && this.emailFrom) {
      this.emailTransport=require('nodemailer').createTransport({host:process.env.PRODUCT_SMTP_HOST,port:Number(process.env.PRODUCT_SMTP_PORT)||587,
        secure:process.env.PRODUCT_SMTP_SECURE==='true',auth:process.env.PRODUCT_SMTP_USER?{user:process.env.PRODUCT_SMTP_USER,pass:process.env.PRODUCT_SMTP_PASSWORD}:undefined,
        connectionTimeout:10000,greetingTimeout:10000,socketTimeout:20000});
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS delivery_preferences(user_id TEXT PRIMARY KEY,email_enabled INTEGER NOT NULL DEFAULT 0,push_enabled INTEGER NOT NULL DEFAULT 0,saved_search_enabled INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS delivery_settings(id INTEGER PRIMARY KEY CHECK(id=1),email_enabled INTEGER NOT NULL DEFAULT 1,push_enabled INTEGER NOT NULL DEFAULT 1);
      INSERT OR IGNORE INTO delivery_settings(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS delivery_devices(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,provider TEXT NOT NULL,token TEXT NOT NULL,label TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(provider,token),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS delivery_outbox(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,notification_id TEXT NOT NULL,channel TEXT NOT NULL,device_id TEXT NOT NULL DEFAULT '',payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,lease_until TEXT NOT NULL DEFAULT '',lease_token TEXT NOT NULL DEFAULT '',last_error TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,sent_at TEXT NOT NULL DEFAULT '',UNIQUE(user_id,notification_id,channel,device_id),FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS outbox_due_idx ON delivery_outbox(status,next_at);
      CREATE TABLE IF NOT EXISTS saved_search_delivery(search_id TEXT PRIMARY KEY,user_id TEXT NOT NULL,initialized_at TEXT NOT NULL,FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,FOREIGN KEY(search_id) REFERENCES saved_searches(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS saved_search_seen(search_id TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(search_id,job_id),FOREIGN KEY(search_id) REFERENCES saved_search_delivery(search_id) ON DELETE CASCADE);`);
  }
  now(){return new Date(this.platform.clock()).toISOString();}
  preferences(user) {
    const row=this.db.prepare('SELECT * FROM delivery_preferences WHERE user_id=?').get(user.id);
    return {emailEnabled:Boolean(row?.email_enabled),pushEnabled:Boolean(row?.push_enabled),savedSearchEnabled:Boolean(row?.saved_search_enabled),updatedAt:row?.updated_at || ''};
  }
  setPreferences(user,input={}) {
    const old=this.preferences(user); const value={...old};
    for(const key of ['emailEnabled','pushEnabled','savedSearchEnabled']) if(input[key]!==undefined){if(typeof input[key]!=='boolean')fail('提醒开关必须为布尔值');value[key]=input[key];}
    this.db.prepare('INSERT INTO delivery_preferences(user_id,email_enabled,push_enabled,saved_search_enabled,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email_enabled=excluded.email_enabled,push_enabled=excluded.push_enabled,saved_search_enabled=excluded.saved_search_enabled,updated_at=excluded.updated_at')
      .run(user.id,Number(value.emailEnabled),Number(value.pushEnabled),Number(value.savedSearchEnabled),this.now());
    for(const [channel,key] of [['email','emailEnabled'],['push','pushEnabled']]) if(!value[key])this.db.prepare("UPDATE delivery_outbox SET status='cancelled',lease_token='' WHERE user_id=? AND channel=? AND status NOT IN ('sent','dead','cancelled')").run(user.id,channel);
    return this.preferences(user);
  }
  status(user) {
    const settings=this.db.prepare('SELECT * FROM delivery_settings WHERE id=1').get();
    return {preferences:this.preferences(user),channels:{email:{configured:Boolean(this.emailTransport && this.emailFrom),enabled:Boolean(settings.email_enabled),verified:Boolean(this.platform.store.getUser(user.id)?.emailVerifiedAt)},push:{configured:Boolean(this.pushProvider?.id && this.pushProvider?.send),enabled:Boolean(settings.push_enabled)}},
      outbox:this.db.prepare('SELECT channel,status,COUNT(*) AS count FROM delivery_outbox WHERE user_id=? GROUP BY channel,status').all(user.id),devices:this.devices(user)};
  }
  devices(user){return this.db.prepare('SELECT id,provider,label,created_at AS createdAt,updated_at AS updatedAt FROM delivery_devices WHERE user_id=? ORDER BY created_at DESC').all(user.id);}
  accountExport(user) {
    return {deliveryPreferences:this.preferences(user),deliveryDevices:this.devices(user),deliveryHistory:this.db.prepare('SELECT id,notification_id AS notificationId,channel,status,attempts,last_error AS lastError,created_at AS createdAt,sent_at AS sentAt FROM delivery_outbox WHERE user_id=? ORDER BY created_at,id').all(user.id)};
  }
  registerDevice(user,input={}) {
    const provider=String(input.provider||''); const token=typeof input.token==='string'?input.token.trim():'';
    if(!/^[a-z][a-z0-9_-]{0,39}$/.test(provider) || token.length<16 || token.length>4096 || /[\r\n\0]/.test(token))fail('设备 provider/token 格式无效');
    if(!this.pushProvider?.id || provider!==this.pushProvider.id)fail('对应推送服务未配置，不能注册设备',503,'PUSH_NOT_CONFIGURED');
    const label=String(input.label||'手机设备').slice(0,100);
    const prior=this.db.prepare('SELECT * FROM delivery_devices WHERE provider=? AND token=?').get(provider,token);
    if(prior && prior.user_id!==user.id)fail('设备已关联其他账户，请先注销原账户设备',409,'DEVICE_IN_USE');
    if(!prior && this.devices(user).length>=10)fail('每个账户最多注册 10 个设备');
    const id=prior?.id || uuid();
    this.db.prepare('INSERT INTO delivery_devices(id,user_id,provider,token,label,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,updated_at=excluded.updated_at').run(id,user.id,provider,token,label,this.now(),this.now());
    return this.devices(user).find(item=>item.id===id);
  }
  removeDevice(user,id) {
    if(!this.db.prepare('DELETE FROM delivery_devices WHERE id=? AND user_id=?').run(id,user.id).changes)fail('设备不存在',404,'NOT_FOUND');
    this.db.prepare("UPDATE delivery_outbox SET status='cancelled',lease_token='' WHERE user_id=? AND device_id=? AND status<>'sent'").run(user.id,id);
    return {deleted:true};
  }
  savedSearchNotifications(user) {
    if(!this.preferences(user).savedSearchEnabled)return;
    for(const search of this.db.prepare('SELECT * FROM saved_searches WHERE user_id=?').all(user.id)) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
      const info=json(search.payload_json); const initialized=this.db.prepare('SELECT search_id FROM saved_search_delivery WHERE search_id=?').get(search.id);
      this.db.prepare('INSERT OR IGNORE INTO saved_search_delivery(search_id,user_id,initialized_at) VALUES(?,?,?)').run(search.id,user.id,this.now());
      let cursor=''; const fresh=[];
      // Bounded traversal: do not turn one user's saved query into an unbounded worker.
      for(let page=0;page<50;page++) {
        const results=this.platform.listJobs({user,filters:info.filters,cursor,limit:100});
        for(const job of results.items)if(this.db.prepare('INSERT OR IGNORE INTO saved_search_seen(search_id,job_id) VALUES(?,?)').run(search.id,String(job.id)).changes && initialized)fresh.push(job);
        if(!results.nextCursor)break;cursor=results.nextCursor;
      }
      if(fresh.length) {
        const digest=crypto.createHash('sha256').update(fresh.map(j=>String(j.id)).sort().join('|')).digest('hex').slice(0,24);
        this.db.prepare('INSERT OR IGNORE INTO user_notifications(user_id,id,title,body,link,created_at) VALUES(?,?,?,?,?,?)').run(user.id,`search:${search.id}:${digest}`,'保存搜索有新岗位',`${info.name} · 新发现 ${fresh.length} 个匹配岗位`,'/workspace?tab=searches',this.now());
      }
      this.db.exec('COMMIT');
      } catch(error){this.db.exec('ROLLBACK');throw error;}
    }
  }
  generate() {
    let users=0,errors=0;
    for(const record of this.db.prepare("SELECT id FROM users WHERE status='active'").all()) {
      try {
      const user=this.platform.store.getUser(record.id);
      this.platform.notifications(user);this.savedSearchNotifications(user);users++;
      const prefs=this.preferences(user); if(!prefs.updatedAt)continue;
      const rows=this.db.prepare('SELECT * FROM user_notifications WHERE user_id=? AND created_at>=?').all(user.id,prefs.updatedAt);
      for(const notification of rows) {
        const payload=JSON.stringify({title:notification.title,body:notification.body,link:notification.link});
        const add=(channel,device='')=>this.db.prepare('INSERT OR IGNORE INTO delivery_outbox(id,user_id,notification_id,channel,device_id,payload_json,next_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(uuid(),user.id,notification.id,channel,device,payload,this.now(),this.now());
        if(prefs.emailEnabled)add('email');
        if(prefs.pushEnabled)for(const device of this.devices(user))add('push',device.id);
      }
      } catch(_){errors++;}
    }
    return {users,generationErrors:errors};
  }
  async dispatch(limit=50) {
    let sent=0,failed=0,blocked=0;
    const due=this.db.prepare("SELECT * FROM delivery_outbox WHERE (status IN ('pending','retry','blocked') AND next_at<=?) OR (status='sending' AND lease_until<=?) ORDER BY created_at LIMIT ?").all(this.now(),this.now(),Math.min(100,Math.max(1,limit)));
    for(const row of due) {
      if(this.stopping)break;
      const token=uuid(); const lease=new Date(this.platform.clock()+120000).toISOString();
      if(!this.db.prepare("UPDATE delivery_outbox SET status='sending',lease_until=?,lease_token=? WHERE id=? AND ((status IN ('pending','retry','blocked') AND next_at<=?) OR (status='sending' AND lease_until<=?))").run(lease,token,row.id,this.now(),this.now()).changes)continue;
      const finish=(status,error='',delay=0,attempt=false)=>this.db.prepare('UPDATE delivery_outbox SET status=?,last_error=?,next_at=?,lease_until=\'\',lease_token=\'\',attempts=attempts+?,sent_at=? WHERE id=? AND lease_token=?').run(status,error,new Date(this.platform.clock()+delay).toISOString(),Number(attempt),status==='sent'?this.now():'',row.id,token);
      const user=this.platform.store.getUser(row.user_id); const prefs=user&&this.preferences(user);const settings=this.db.prepare('SELECT * FROM delivery_settings WHERE id=1').get();
      if(!user || user.status!=='active' || !(row.channel==='email'?prefs.emailEnabled:prefs.pushEnabled)){finish('cancelled');continue;}
      const payload=json(row.payload_json);let deliver;
      if(row.channel==='email') {
        if(!settings.email_enabled || !this.emailTransport || !this.emailFrom || !user.emailVerifiedAt){finish('blocked',!user.emailVerifiedAt?'EMAIL_UNVERIFIED':'EMAIL_NOT_CONFIGURED',300000);blocked++;continue;}
        deliver=async()=>{
          const result=await this.emailTransport.sendMail({from:this.emailFrom,to:user.email,subject:payload.title,text:`${payload.body}\n${this.publicBaseUrl?this.publicBaseUrl.replace(/\/$/,'')+payload.link:''}\n可在账户提醒设置中关闭邮件提醒。`,messageId:`<${row.id}@zhilu-notifications.local>`});
          if(result?.rejected?.length || (Array.isArray(result?.accepted)&&!result.accepted.length))throw new Error('MAIL_NOT_ACCEPTED');
        };
      } else {
        const device=this.db.prepare('SELECT * FROM delivery_devices WHERE id=? AND user_id=?').get(row.device_id,user.id);
        if(!device){finish('cancelled');continue;}
        if(!settings.push_enabled || !this.pushProvider?.send || this.pushProvider.id!==device.provider){finish('blocked','PUSH_NOT_CONFIGURED',300000);blocked++;continue;}
        deliver=()=>this.pushProvider.send({token:device.token,payload,idempotencyKey:row.id});
      }
      try {await deliver();finish('sent','',0,true);sent++;}
      catch(error){const attempts=row.attempts+1;finish(attempts>=5?'dead':'retry','DELIVERY_FAILED',Math.min(3600000,30000*2**attempts),true);failed++;}
    }
    return {sent,failed,blocked};
  }
  async tick(){if(this.running||this.stopping)return {busy:true};this.running=true;try{return {attachmentCleanup:require('./attachments').initializeAttachments(this.platform).retryCleanup(),...this.generate(),...await this.dispatch()};}finally{this.running=false;}}
  integrations(actor) {
    this.platform.requireRole(actor,['admin']);const settings=this.db.prepare('SELECT * FROM delivery_settings WHERE id=1').get();
    return {payment:new ProductCommerce(this.platform).paymentStatus(),email:{configured:Boolean(this.emailTransport&&this.emailFrom),enabled:Boolean(settings.email_enabled),requiredEnvironment:['PRODUCT_SMTP_HOST','PRODUCT_SMTP_PORT','PRODUCT_SMTP_FROM','PRODUCT_SMTP_USER','PRODUCT_SMTP_PASSWORD'],note:'仅发送给主动订阅且已验证的账户邮箱，不使用全局 EMAIL_TO'},push:{configured:Boolean(this.pushProvider?.send),enabled:Boolean(settings.push_enabled),provider:this.pushProvider?.id || '',note:'注入 pushProvider 后启用；未配置时不发送'},delivery:{scheduleIntervalSeconds:60,semantics:'至少一次投递；提供稳定幂等键，失败最多重试 5 次'},attachments:{pendingCleanup:require('./attachments').initializeAttachments(this.platform).cleanupStatus().pending}};
  }
  configure(actor,input={}) {
    this.platform.requireRole(actor,['admin']);
    const current=this.db.prepare('SELECT * FROM delivery_settings WHERE id=1').get();
    for(const key of ['emailEnabled','pushEnabled'])if(input[key]!==undefined&&typeof input[key]!=='boolean')fail('渠道开关格式不正确');
    this.db.prepare('UPDATE delivery_settings SET email_enabled=?,push_enabled=? WHERE id=1').run(Number(input.emailEnabled??Boolean(current.email_enabled)),Number(input.pushEnabled??Boolean(current.push_enabled)));
    new ProductCommerce(this.platform).audit(actor,'delivery.settings_updated','integration','delivery',{emailEnabled:input.emailEnabled,pushEnabled:input.pushEnabled});
    return this.integrations(actor);
  }
}
function initializeDelivery(platform,options={}) {if(!services.has(platform))services.set(platform,new DeliveryService(platform,options));return services.get(platform);}
function startDeliveryScheduler(platform,options={}) {
  const service=initializeDelivery(platform,options);const intervalMs=Math.max(30000,Number(options.intervalMs)||60000);
  service.stopping=false;
  const run=()=>service.tick().catch(()=>{options.onError?.('DELIVERY_TICK_FAILED');});
  const timer=setInterval(run,intervalMs);timer.unref?.();if(options.immediate!==false)void run();
  return ()=>{clearInterval(timer);service.stopping=true;};
}
function registerDeliveryRoutes(router,{platform,requireAuth,...options}) {
  const service=initializeDelivery(platform,options);const route=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
  router.get('/me/delivery-preferences',requireAuth,route((req,res)=>res.json({ok:true,...service.preferences(req.productUser)})));
  router.put('/me/delivery-preferences',requireAuth,route((req,res)=>res.json({ok:true,...service.setPreferences(req.productUser,req.body)})));
  router.get('/me/delivery-status',requireAuth,route((req,res)=>res.json({ok:true,...service.status(req.productUser)})));
  router.get('/me/devices',requireAuth,route((req,res)=>res.json({ok:true,devices:service.devices(req.productUser)})));
  router.post('/me/devices',requireAuth,route((req,res)=>res.status(201).json({ok:true,device:service.registerDevice(req.productUser,req.body)})));
  router.delete('/me/devices/:id',requireAuth,route((req,res)=>res.json({ok:true,...service.removeDevice(req.productUser,req.params.id)})));
  router.get('/admin/integrations',requireAuth,route((req,res)=>res.json({ok:true,...service.integrations(req.productUser)})));
  router.put('/admin/integrations/delivery',requireAuth,route((req,res)=>res.json({ok:true,...service.configure(req.productUser,req.body)})));
  return service;
}
module.exports={DeliveryService,initializeDelivery,startDeliveryScheduler,registerDeliveryRoutes};
