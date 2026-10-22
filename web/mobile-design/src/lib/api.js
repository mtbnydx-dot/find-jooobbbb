// The mobile site uses the exact same cookie/session and API contract as the web app.
export { api, request, ApiError, AUTH_REQUIRED_EVENT, clearNativeSession, newRequestKey, listPayload } from '../../../src/lib/api.js';
export { workspaceApi } from '../../../src/lib/workspace-api.js';
export const webAppBase = __PRODUCT_API_BASE__ === '/api/v1' ? '/app' : __PRODUCT_API_BASE__.replace(/\/api\/v1$/, '');
