'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createApp, productBootstrapRoles } = require('./server');
const { ProductPlatform } = require('./product');
const { productRuntimeOptions, configureProductRuntime, startProductWorkers } = require('./product/runtime');

function catalogReader(file) {
  let snapshot; let revision=''; let checkedAt=0;
  return { snapshot() {
    if (snapshot && Date.now()-checkedAt<1000) return snapshot;
    checkedAt=Date.now();
    const stat=fs.statSync(file);const next=`${stat.mtimeMs}:${stat.size}`;
    if (next!==revision) {
      const parsed=JSON.parse(fs.readFileSync(file,'utf8'));
      if (!Array.isArray(parsed.jobs) || !parsed.version || !parsed.jobs.length) throw new Error('Published catalog invalid');
      snapshot=parsed;revision=next;
    }
    return snapshot;
  } };
}
function startProductServer(env=process.env) {
  if (!env.PUBLIC_CATALOG_FILE || !env.DATA_DIR) throw new Error('PUBLIC_CATALOG_FILE and DATA_DIR are required');
  const service=catalogReader(path.resolve(env.PUBLIC_CATALOG_FILE));service.snapshot();
  const product=new ProductPlatform({ dataDir:path.resolve(env.DATA_DIR),jobService:service,bootstrapRoles:productBootstrapRoles(env),bootstrapToken:env.PRODUCT_BOOTSTRAP_TOKEN || '',...productRuntimeOptions(env) }).initialize();
  configureProductRuntime(product,env);
  const app=createApp({ service,product,cloud:null,legacyAdminOnly:true,editPassword:'',aiEditPassword:'' });
  let appliedVersion='';
  const applyAliases=()=>{
    const catalog=service.snapshot();
    if (catalog.version===appliedVersion) return;
    const ids=new Set(catalog.jobs.map(job=>job.id));
    const aliases=Object.fromEntries(Object.entries(catalog.aliases || {}).filter(([oldId,newId])=>!ids.has(oldId) && ids.has(newId)));
    if (Object.keys(aliases).length) product.remapJobAliases(aliases);
    appliedVersion=catalog.version;
  };
  applyAliases();const poll=setInterval(()=>{try{applyAliases();}catch(error){console.error(error.message);}},30000);poll.unref();
  // The personal AI worker uses explicitly provisioned credentials and this product's
  // per-user profiles. It cannot read the legacy private workspace or global profile.
  const workers=startProductWorkers(product,env);
  const server=app.listen(Number(env.PORT || 3201),env.BIND_HOST || '127.0.0.1',()=>console.log('Product service ready'));
  let stopping=false;
  const stop=async()=>{if(stopping)return;stopping=true;clearInterval(poll);const closed=new Promise(resolve=>server.close(resolve));await workers.stop();await closed;product.close();process.exit(0);};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  return { server,product,service,workers };
}
if (require.main===module) startProductServer();
module.exports={ catalogReader,startProductServer };
