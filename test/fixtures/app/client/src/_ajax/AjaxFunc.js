import { stringFormat } from 'fake-utils';
import * as Ajax from './Ajax';
import Option from '_define/Option';

export const ajaxSignIn = async (form) => Ajax.request({ info: Option.REST_API.AUTH.SIGN_IN, body: form });

export const ajaxDocumentList = async () => Ajax.request({ info: Option.REST_API.DOCUMENT.LIST });

export const ajaxDocumentDetail = async (id) => {
  const apiInfo = Option.REST_API.DOCUMENT.DETAIL;
  return Ajax.request({ info: { METHOD: apiInfo.METHOD, URL: stringFormat(apiInfo.URL, id) } });
};

export const ajaxDocumentRename = async (id, name) => {
  const apiInfo = Option.REST_API.DOCUMENT.RENAME;
  return Ajax.request({ info: { ...apiInfo, URL: stringFormat(apiInfo.URL, id) }, body: { name } });
};

export const ajaxDocumentArchive = async (ids) => Ajax.request({ info: Option.REST_API.DOCUMENT.ARCHIVE, body: { ids } });

export const ajaxDownload = async (url) => Ajax.request({ info: { METHOD: 'GET', URL: url } });

export const ajaxMemberList = async ({ page, showError = true }) => {
  const res = await Ajax.request({ info: Option.REST_API.MEMBER.LIST, params: { page } });
  if (res.failed && showError) window.alert(res.error);
  return res;
};

export const ajaxLabExperiment = async () => Ajax.request({ info: Option.REST_API.LAB.EXPERIMENT });

export const ajaxReportExport = async (body) => Ajax.request({ info: Option.REST_API.REPORT.EXPORT, body });

export const ajaxReportArchive = async ({ data }) => Ajax.request({ info: Option.REST_API.REPORT.ARCHIVE, body: data });

export const ajaxReportSchedule = async (body) => Ajax.request({ info: Option.REST_API.REPORT.SCHEDULE, body });
