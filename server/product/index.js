'use strict';

const { ProductPlatform, ProductError, JOB_STATUSES, ROLES } = require('./platform');
const { createProductRouter } = require('./router');
const { ProductStore } = require('./store');

module.exports = {
  createProductRouter,
  JOB_STATUSES,
  ProductError,
  ProductPlatform,
  ProductStore,
  ROLES,
};
