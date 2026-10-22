'use strict';

const { initializePersonalAi } = require('./personal-ai');
const { initializeDelivery, startDeliveryScheduler } = require('./delivery');

function emailOptions(env = process.env) {
  if (!env.PRODUCT_SMTP_HOST || !env.PRODUCT_SMTP_FROM) return {};
  const transport = require('nodemailer').createTransport({
    host: env.PRODUCT_SMTP_HOST, port: Number(env.PRODUCT_SMTP_PORT) || 587,
    secure: env.PRODUCT_SMTP_SECURE === 'true',
    auth: env.PRODUCT_SMTP_USER ? { user: env.PRODUCT_SMTP_USER, pass: env.PRODUCT_SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  return { emailTransport: transport, emailFrom: env.PRODUCT_SMTP_FROM };
}

function productRuntimeOptions(env = process.env) {
  const email = emailOptions(env);
  return {
    publicAppUrl: env.PRODUCT_PUBLIC_URL || '',
    corsOrigins: String(env.PRODUCT_CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean),
    authMessageSender: email.emailTransport ? async message => {
      const result = await email.emailTransport.sendMail({ from: email.emailFrom, to: message.to, subject: message.subject, text: message.text });
      if (result.rejected?.length || (Array.isArray(result.accepted) && !result.accepted.length)) throw new Error('MAIL_NOT_ACCEPTED');
      return true;
    } : null,
  };
}

function configureProductRuntime(platform, env = process.env) {
  initializePersonalAi(platform, { env });
  initializeDelivery(platform, { ...emailOptions(env), publicBaseUrl: env.PRODUCT_PUBLIC_URL || '' });
  require('./announcement-enrichment').initializeAnnouncements(platform);
  return platform;
}

function startProductWorkers(platform, env = process.env) {
  if (!platform || env.PRODUCT_WORKERS_ENABLED === '0') return { stop: async () => {} };
  configureProductRuntime(platform, env);
  platform.personalAi.start();
  platform.announcements.start();
  const delivery = initializeDelivery(platform);
  const stopDelivery = startDeliveryScheduler(platform, { immediate: false, onError: code => console.error(code) });
  return { async stop() {
    stopDelivery();
    await Promise.all([platform.personalAi.drain(), platform.announcements.drain()]);
    while (delivery.running) await new Promise(resolve => setTimeout(resolve, 100));
  } };
}

module.exports = { emailOptions, productRuntimeOptions, configureProductRuntime, startProductWorkers };
