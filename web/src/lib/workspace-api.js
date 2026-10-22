import { request } from './api';
export const workspaceApi = {
  get: signal => request('/me/workspace', {signal}),
  saveSearch: body => request('/me/saved-searches', {method:'POST',body}),
  deleteSearch: id => request(`/me/saved-searches/${encodeURIComponent(id)}`, {method:'DELETE'}),
  saveOffer: (body,id) => request(`/me/offers${id ? `/${encodeURIComponent(id)}` : ''}`, {method:id?'PUT':'POST',body}),
  deleteOffer: id => request(`/me/offers/${encodeURIComponent(id)}`, {method:'DELETE'}),
  saveStudy: (body,id) => request(`/me/study-plans${id ? `/${encodeURIComponent(id)}` : ''}`, {method:id?'PUT':'POST',body}),
  deleteStudy: id => request(`/me/study-plans/${encodeURIComponent(id)}`, {method:'DELETE'}),
  customJob: (body,id) => request(`/me/custom-jobs${id?`/${encodeURIComponent(id)}`:''}`, {method:id?'PUT':'POST',body}),
  deleteCustomJob: id => request(`/me/custom-jobs/${encodeURIComponent(id)}`, {method:'DELETE'}),
};
