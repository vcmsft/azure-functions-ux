import { FunctionsHttpService } from './functions-http.service';
import { FunctionsResponse } from './../models/functions-response';
import { WebApiException } from './../models/webapi-exception';
import { AiService } from './ai.service';
import { ArmService } from './arm.service';
import { BindingConfig } from '../models/binding';
import { BroadcastEvent } from '../models/broadcast-event';
import { BroadcastService } from './broadcast.service';
import { Cache, ClearAllFunctionCache, ClearCache } from '../decorators/cache.decorator';
import { Constants } from '../models/constants';
import { Cookie } from 'ng2-cookies/ng2-cookies';
import { CreateFunctionInfo } from '../models/create-function-info';
import { DesignerSchema } from '../models/designer-schema';
import { ErrorEvent, ErrorLevel } from '../models/error-event';
import { FunctionContainer } from '../models/function-container';
import { FunctionInfo } from '../models/function-info';
import { FunctionKey, FunctionKeys } from '../models/function-key';
import { FunctionSecrets } from '../models/function-secrets';
import { FunctionTemplate } from '../models/function-template';
import { GlobalStateService } from './global-state.service';
import { Headers, Http, Response, ResponseType } from '@angular/http';
import { HttpRunModel } from '../models/http-run';
import { Injectable } from '@angular/core';
import { ITryAppServiceTemplate, UIResource } from '../models/ui-resource';
import { Observable } from 'rxjs/Rx';
import { PortalResources } from '../models/portal-resources';
import { RunFunctionResult } from '../models/run-function-result';
import { TranslateService } from 'ng2-translate/ng2-translate';
import { UserService } from './user.service';
import { VfsObject } from '../models/vfs-object';
import { ErrorIds } from '../models/error-ids';

declare var mixpanel: any;

@Injectable()
export class FunctionsService {
    private masterKey: string;
    private token: string;
    private _scmUrl: string;
    private siteName: string;
    private mainSiteUrl: string;
    public isEasyAuthEnabled: boolean;
    public selectedFunction: string;
    public selectedLanguage: string;
    public selectedProvider: string;
    public selectedFunctionName: string;

    public isMultiKeySupported: boolean = true;

    // https://www.w3.org/Protocols/rfc2616/rfc2616-sec10.html
    private statusCodeMap = {
        0: 'Unknown HTTP Error',
        100: 'Continue',
        101: 'Switching Protocols',
        102: 'Processing',
        200: 'OK',
        201: 'Created',
        202: 'Accepted',
        203: 'Non-Authoritative Information',
        204: 'No Content',
        205: 'Reset Content',
        206: 'Partial Content',
        300: 'Multiple Choices',
        301: 'Moved Permanently',
        302: 'Found',
        303: 'See Other',
        304: 'Not Modified',
        305: 'Use Proxy',
        306: '(Unused)',
        307: 'Temporary Redirect',
        400: 'Bad Request',
        401: 'Unauthorized',
        402: 'Payment Required',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        406: 'Not Acceptable',
        407: 'Proxy Authentication Required',
        408: 'Request Timeout',
        409: 'Conflict',
        410: 'Gone',
        411: 'Length Required',
        412: 'Precondition Failed',
        413: 'Request Entity Too Large',
        414: 'Request-URI Too Long',
        415: 'Unsupported Media Type',
        416: 'Requested Range Not Satisfiable',
        417: 'Expectation Failed',
        500: 'Internal Server Error',
        501: 'Not Implemented',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
        504: 'Gateway Timeout',
        505: 'HTTP Version Not Supported'
    };

    private genericStatusCodeMap = {
        100: 'Informational',
        200: 'Success',
        300: 'Redirection',
        400: 'Client Error',
        500: 'Server Error'
    };

    private tryAppServiceUrl = 'https://tryappservice.azure.com';
    private functionContainer: FunctionContainer;

    constructor(
        private _http: FunctionsHttpService,
        private _userService: UserService,
        private _globalStateService: GlobalStateService,
        private _translateService: TranslateService,
        private _broadcastService: BroadcastService,
        private _armService: ArmService,
        private _aiService: AiService) {

        if (!Constants.runtimeVersion) {
            this.getLatestRuntime().subscribe((runtime: any) => {
                Constants.runtimeVersion = runtime;
            });
        }

        if (!Constants.routingExtensionVersion) {
            this.getLatestRoutingExtensionVersion().subscribe((routingVersion: any) => {
                Constants.routingExtensionVersion = routingVersion;
            });
        }

        if (!_globalStateService.showTryView) {
            this._userService.getToken().subscribe(t => this.token = t);
            this._userService.getFunctionContainer().subscribe(fc => {
                this.functionContainer = fc;
                this._scmUrl = `https://${fc.properties.hostNameSslStates.find(s => s.hostType === 1).name}`;
                this.mainSiteUrl = `https://${fc.properties.defaultHostName}`;
                this.siteName = fc.name;
            });
        }
        if (Cookie.get('TryAppServiceToken')) {
            this._globalStateService.TryAppServiceToken = Cookie.get('TryAppServiceToken');
            let templateId = Cookie.get('templateId');
            this.selectedFunction = templateId.split('-')[0].trim();
            this.selectedLanguage = templateId.split('-')[1].trim();
            this.selectedProvider = Cookie.get('provider');
            this.selectedFunctionName = Cookie.get('functionName');
        }
    }

    getParameterByName(url, name) {
        if (url === null) {
            url = window.location.href;
        }

        name = name.replace(/[\[\]]/g, '\\$&');
        let regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)');
        let results = regex.exec(url);

        if (!results) {
            return null;
        }

        if (!results[2]) {
            return '';
        }

        return decodeURIComponent(results[2].replace(/\+/g, ' '));
    }

    setScmParams(fc: FunctionContainer) {
        this._scmUrl = `https://${fc.properties.hostNameSslStates.find(s => s.hostType === 1).name}`;
        this.mainSiteUrl = `https://${fc.properties.defaultHostName}`;
        this.siteName = fc.name;
        if (fc.tryScmCred != null) {
            this._globalStateService.ScmCreds = fc.tryScmCred;
        }
    }

    @Cache()
    getFunctions() {
        return this._http.get(`${this._scmUrl}/api/functions`, { headers: this.getScmSiteHeaders() })
            .retryWhen(this.retryAntares)
            .map<FunctionInfo[]>((r: Response) => {
                try {
                    return r.json();
                } catch (e) {
                    // We have seen this happen when kudu was returning JSON that contained
                    // comments because Json.NET is okay with comments in the JSON file.
                    // We can't parse that JSON in browser, so this is just to handle the error correctly.
                    this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                        message: this._translateService.instant(PortalResources.error_parsingFunctionListReturenedFromKudu),
                        errorId: ErrorIds.deserializingKudusFunctionList,
                        errorLevel: ErrorLevel.Fatal
                    });
                    this.trackEvent(ErrorIds.deserializingKudusFunctionList, {
                        error: e,
                        content: r.text(),
                    });
                    return [];
                }
            })
            .do(r => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveFunctionsList),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToRetrieveFunctionListFromKudu),
                            errorId: ErrorIds.unableToRetrieveFunctionsList,
                            errorLevel: ErrorLevel.Fatal
                        });
                        this.trackEvent(ErrorIds.unableToRetrieveFunctionsList, {
                            content: error.text(),
                            status: error.status.toString()
                        });
                    }
                });

    }

    getApiProxies() {
        return this._http.get(`${this._scmUrl}/api/vfs/site/wwwroot/proxies.json`, { headers: this.getScmSiteHeaders() })
            .map<any>(r => {
                return r.json();
            })
            .catch(_ => Observable.of({
                json: () => { return {}; }
            }));
    }

    saveApiProxy(jsonString: string) {
        let headers = this.getScmSiteHeaders();
        // https://github.com/projectkudu/kudu/wiki/REST-API
        headers.append('If-Match', '*');

        return this._http.put(`${this._scmUrl}/api/vfs/site/wwwroot/proxies.json`, jsonString, { headers: headers });
    }

    /**
     * This function returns the content of a file from kudu as a string.
     * @param file either a VfsObject or a string representing the file's href.
     */
    @Cache('href')
    getFileContent(file: VfsObject | string) {
        let fileHref = typeof file === 'string' ? file : file.href;
        let fileName = this.getFileName(file);
        return this._http.get(fileHref, { headers: this.getScmSiteHeaders() })
            .map<string>(r => r.text())
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveFileContent + fileName),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToGetFileContentFromKudu, {fileName: fileName}),
                            errorId: ErrorIds.unableToRetrieveFileContent + fileName,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToRetrieveFileContent, {
                            fileHref: fileHref,
                            content: error.text(),
                            status: error.status.toString()
                        });
                    }
                });
    }

    @ClearCache('getFileContent', 'href')
    saveFile(file: VfsObject | string, updatedContent: string, functionInfo?: FunctionInfo) {
        let fileHref = typeof file === 'string' ? file : file.href;
        let fileName = this.getFileName(file);
        let headers = this.getScmSiteHeaders('plain/text');
        headers.append('If-Match', '*');

        if (functionInfo) {
            ClearAllFunctionCache(functionInfo);
        }

        return this._http.put(fileHref, updatedContent, { headers: headers })
            .map<VfsObject | string>(r => file)
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToSaveFileContent + fileName),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToSaveFileContentThroughKudu, {fileName: fileName}),
                            errorId: ErrorIds.unableToSaveFileContent + fileName,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToSaveFileContent, {
                            fileHref: fileHref,
                            content: error.text(),
                            status: error.status.toString()
                        });
                    }
                });
    }

    @ClearCache('getFileContent', 'href')
    deleteFile(file: VfsObject | string, functionInfo?: FunctionInfo) {
        let fileHref = typeof file === 'string' ? file : file.href;
        let fileName = this.getFileName(file);
        let headers = this.getScmSiteHeaders('plain/text');
        headers.append('If-Match', '*');

        if (functionInfo) {
            ClearAllFunctionCache(functionInfo);
        }

        return this._http.delete(fileHref, { headers: headers })
            .map<VfsObject | string>(r => file)
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToDeleteFile + fileName),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToDeleteFileThroughKudu, {fileName: fileName}),
                            errorId: ErrorIds.unableToDeleteFile + fileName,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToDeleteFile, {
                            fileHref: fileHref,
                            content: error.text(),
                            status: error.status.toString()
                        });
                    }
                });
    }

    ClearAllFunctionCache(functionInfo: FunctionInfo) {
        ClearAllFunctionCache(functionInfo);
    }

    // This function is special cased in the Cache() decorator by name to allow for dev scenarios.
    @Cache()
    getTemplates() {
        try {
            if (localStorage.getItem('dev-templates')) {
                let devTemplate: FunctionTemplate[] = JSON.parse(localStorage.getItem('dev-templates'));
                this.localize(devTemplate);
                return Observable.of(devTemplate);
            }
        } catch (e) {
            console.error(e);
        }
        let url = `${Constants.serviceHost}api/templates?runtime=${this._globalStateService.ExtensionVersion || 'latest'}`;
        return this._http.get(url, { headers: this.getPortalHeaders() })
            .retryWhen(this.retryAntares)
            .map<FunctionTemplate[]>(r => {
                let object = r.json();
                this.localize(object);
                return object;
            });
    }

    @ClearCache('getFunctions')
    createFunction(functionName: string, templateId: string) {
        let observable: Observable<FunctionInfo>;
        if (templateId) {
            let body: CreateFunctionInfo = {
                name: functionName,
                templateId: (templateId && templateId !== 'Empty' ? templateId : null),
                containerScmUrl: this._scmUrl
            };
            observable = this._http.put(`${this._scmUrl}/api/functions/${functionName}`, JSON.stringify(body), { headers: this.getScmSiteHeaders() })
                .map<FunctionInfo>(r => r.json());
        } else {
            observable = this._http
                .put(`${this._scmUrl}/api/functions/${functionName}`, JSON.stringify({ config: {} }), { headers: this.getScmSiteHeaders() })
                .map<FunctionInfo>(r => r.json());
        }

        return observable
                .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToCreateFunction + functionName),
                    (error: FunctionsResponse) => {
                        if (!error.isHandled) {
                            this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                                message: this._translateService.instant(PortalResources.error_unableToCreateFunction, { functionName: functionName }),
                                errorId: ErrorIds.unableToCreateFunction + functionName,
                            errorLevel: ErrorLevel.ApiError
                            });
                            this.trackEvent(ErrorIds.unableToCreateFunction, {
                                content: error.text(),
                                status: error.status.toString(),
                            });
                        }
                    });
    }

    getFunctionContainerAppSettings(functionContainer: FunctionContainer) {
        let url = `${this._scmUrl}/api/settings`;
        return this._http.get(url, { headers: this.getScmSiteHeaders() })
            .retryWhen(this.retryAntares)
            .map<{ [key: string]: string }>(r => r.json());
    }

    @ClearCache('getFunctions')
    createFunctionV2(functionName: string, files: any, config: any) {
        let filesCopy = Object.assign({}, files);
        let sampleData = filesCopy['sample.dat'];
        delete filesCopy['sample.dat'];

        let content = JSON.stringify({ files: filesCopy, test_data: sampleData, config: config });
        let url = `${this._scmUrl}/api/functions/${functionName}`;

        return this._http.put(url, content, { headers: this.getScmSiteHeaders() })
            .map<FunctionInfo>(r => r.json())
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToCreateFunction + functionName),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToCreateFunction, { functionName: functionName }),
                            errorId: ErrorIds.unableToCreateFunction + functionName,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToCreateFunction, {
                            content: error.text(),
                            status: error.status.toString(),
                        });
                    }
                });
    }


    getNewFunctionNode(): FunctionInfo {
        return {
            name: this._translateService.instant(PortalResources.sideBar_newFunction),
            href: null,
            config: null,
            script_href: null,
            template_id: null,
            clientOnly: true,
            isDeleted: false,
            secrets_file_href: null,
            test_data: null,
            script_root_path_href: null,
            config_href: null
        };
    }

    statusCodeToText(code: number) {
        let statusClass = Math.floor(code / 100) * 100;
        return this.statusCodeMap[code] || this.genericStatusCodeMap[statusClass] || 'Unknown Status Code';
    }

    runHttpFunction(functionInfo: FunctionInfo, url: string, model: HttpRunModel) {
        let content = model.body;

        let regExp = /\{([^}]+)\}/g;
        let matchesPathParams = url.match(regExp);
        let processedParams = [];

        let splitResults = url.split('?');
        if (splitResults.length === 2) {
            url = splitResults[0];
        }

        if (matchesPathParams) {
            matchesPathParams.forEach((m) => {
                let name = m.split(':')[0].replace('{', '').replace('}', '');
                processedParams.push(name);
                let param = model.queryStringParams.find((p) => {
                    return p.name === name;
                });
                if (param) {
                    url = url.replace(m, param.value);
                }
            });
        }

        let firstDone = false;
        model.queryStringParams.forEach((p, index) => {
            let findResult = processedParams.find((pr) => {
                return pr === p.name;
            });

            if (!findResult) {
                if (!firstDone) {
                    url += '?';
                    firstDone = true;
                } else {
                    url += '&';
                }
                url += p.name + '=' + p.value;
            }
        });
        let inputBinding = (functionInfo.config && functionInfo.config.bindings
            ? functionInfo.config.bindings.find(e => e.type === 'httpTrigger')
            : null);

        let contentType: string;
        if (!inputBinding || inputBinding && inputBinding.webHookType) {
            contentType = 'application/json';
        }

        let headers = this.getMainSiteHeaders(contentType);
        model.headers.forEach((h) => {
            headers.append(h.name, h.value);
        });

        let response: Observable<Response>;
        switch (model.method) {
            case Constants.httpMethods.GET:
                response = this._http.get(url, { headers: headers });
                break;
            case Constants.httpMethods.POST:
                response = this._http.post(url, content, { headers: headers });
                break;
            case Constants.httpMethods.DELETE:
                response = this._http.delete(url, { headers: headers });
                break;
            case Constants.httpMethods.HEAD:
                response = this._http.head(url, { headers: headers });
                break;
            case Constants.httpMethods.PATCH:
                response = this._http.patch(url, content, { headers: headers });
                break;
            case Constants.httpMethods.PUT:
                response = this._http.put(url, content, { headers: headers });
                break;
            default:
                response = this._http.request(url, {
                    headers: headers,
                    method: model.method,
                    body: content
                });
                break;
        }

        return this.runFunctionInternal(response, functionInfo);
    }

    runFunction(functionInfo: FunctionInfo, content: string) {
        let url = `${this.mainSiteUrl}/admin/functions/${functionInfo.name.toLocaleLowerCase()}`;
        let _content: string = JSON.stringify({ input: content });
        let contentType: string;

        try {
            JSON.parse(_content);
            contentType = 'application/json';
        } catch (e) {
            contentType = 'plain/text';
        }

        return this.runFunctionInternal(this._http.post(url, _content, { headers: this.getMainSiteHeaders(contentType) }), functionInfo);

    }

    @ClearCache('clearAllCachedData')
    deleteFunction(functionInfo: FunctionInfo) {
        return this._http.delete(functionInfo.href, { headers: this.getScmSiteHeaders() })
            .map<string>(r => r.statusText)
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToDeleteFunction + functionInfo.name),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToDeleteFunction, { functionName: functionInfo.name }),
                            errorId: ErrorIds.unableToDeleteFunction + functionInfo.name,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToDeleteFunction, {
                            content: error.text(),
                            status: error.status.toString(),
                            href: functionInfo.href
                        });
                    }
                });
    }

    @Cache()
    getDesignerSchema() {
        return this._http.get('mocks/function-json-schema.json')
            .retryWhen(this.retryAntares)
            .map<DesignerSchema>(r => r.json());
    }

    warmupMainSite() {
        if (this.isEasyAuthEnabled) {
            return Observable.of({});
        }
        let observable = this._http.get(this.mainSiteUrl, { headers: this.getScmSiteHeaders() })
            .retryWhen(this.retryAntares)
            .map<string>(r => r.statusText);

        observable.subscribe(() => this.getHostSecretsFromScm(), () => this.getHostSecretsFromScm());
        return observable;
    }

    @Cache('secrets_file_href')
    getSecrets(fi: FunctionInfo) {
        return this._http.get(fi.secrets_file_href, { headers: this.getScmSiteHeaders() })
            .map<FunctionSecrets>(r => r.json())
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveSecretsFileFromKudu + fi.name),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_UnableToRetrieveSecretsFileFromKudu, { functionName: fi.name }),
                            errorId: ErrorIds.unableToRetrieveSecretsFileFromKudu + fi.name,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToRetrieveSecretsFileFromKudu, {
                            status: error.status.toString(),
                            content: error.text(),
                            href: fi.secrets_file_href
                        });
                    }
                });
    }

    @ClearCache('getSecrets', 'secrets_file_href')
    setSecrets(fi: FunctionInfo, secrets: FunctionSecrets) {
        return this.saveFile(fi.secrets_file_href, JSON.stringify(secrets))
            .retryWhen(this.retryAntares)
            .map<FunctionSecrets>(e => secrets);
    }

    @Cache()
    getHostJson() {
        return this._http.get(`${this._scmUrl}/api/functions/config`, { headers: this.getScmSiteHeaders() })
            .map<any>(r => r.json())
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveRuntimeConfig),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToRetrieveRuntimeConfig),
                            errorId: ErrorIds.unableToRetrieveRuntimeConfig,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToRetrieveRuntimeConfig, {
                            status: error.status.toString(),
                            content: error.text(),
                        });
                    }
                });
    }

    @ClearCache('getFunction', 'href')
    saveFunction(fi: FunctionInfo, config: any) {
        ClearAllFunctionCache(fi);
        return this._http.put(fi.href, JSON.stringify({ config: config }), { headers: this.getScmSiteHeaders() })
            .map<FunctionInfo>(r => r.json())
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToUpdateFunction + fi.name),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToUpdateFunction, { functionName: fi.name }),
                            errorId: ErrorIds.unableToUpdateFunction + fi.name,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToUpdateFunction, {
                            status: error.status.toString(),
                            content: error.text(),
                        });
                        return Observable.of('');
                    }
                });
    }

    @Cache('href')
    getFunction(fi: FunctionInfo) {
        return this._http.get(fi.href, { headers: this.getScmSiteHeaders() })
            .map<FunctionInfo>(r => r.json())
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveFunction + fi.name),
                (error: FunctionsResponse) => {
                this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                    message: this._translateService.instant(PortalResources.error_unableToRetrieveFunction, { functionName: fi.name }),
                    errorId: ErrorIds.unableToRetrieveFunction + fi.name,
                    errorLevel: ErrorLevel.ApiError
                });
                this.trackEvent(ErrorIds.unableToRetrieveFunction, {
                    status: error.status.toString(),
                    content: error.text(),
                });
                return Observable.of('');
            });
    }

    getScmUrl() {
        return this._scmUrl;
    }

    getSiteName() {
        return this.siteName;
    }

    getMainSiteUrl(): string {
        return this.mainSiteUrl;
    }

    getHostSecretsFromScm() {
        // call kudu
        return this._http.get(`${this._scmUrl}/api/functions/admin/masterkey`, { headers: this.getScmSiteHeaders() })
            .do((r: Response) => {
                    let key: { masterKey: string } = r.json();
                    this.masterKey = key.masterKey;
                    this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveRuntimeKey);
                },
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        try {
                            let exception: WebApiException = error.json();
                            if (exception.ExceptionType === 'System.Security.Cryptography.CryptographicException') {
                                this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                                    message: this._translateService.instant(PortalResources.error_unableToDecryptKeys),
                                    errorId: ErrorIds.unableToDecryptKeys,
                                    errorLevel: ErrorLevel.Fatal
                                });
                                this.trackEvent(ErrorIds.unableToDecryptKeys, {
                                    content: error.text(),
                                    status: error.status.toString()
                                });
                            }
                        } catch (e) {
                            // no-op
                        }
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToRetrieveRuntimeKey),
                            errorId: ErrorIds.unableToRetrieveRuntimeKey,
                            errorLevel: ErrorLevel.Fatal
                        });
                        this.trackEvent(ErrorIds.unableToRetrieveRuntimeKey, {
                            status: error.status.toString(),
                            content: error.text(),
                        });
                    }
                });
    }

    legacyGetHostSecrets() {
        return this._http.get(`${this._scmUrl}/api/vfs/data/functions/secrets/host.json`, { headers: this.getScmSiteHeaders() })
            .map<string>(r => r.json().masterKey)
            .do(h => {
                this.masterKey = h;
                this.isMultiKeySupported = false;
            });
    }

    getFunctionHostKeys(): Observable<FunctionKeys> {
        if (this.isEasyAuthEnabled) {
            return Observable.of({keys: [], links: []});
        }

        return this._http.get(`${this.mainSiteUrl}/admin/host/keys`, { headers: this.getMainSiteHeaders() })
            .retryWhen(e => e.scan<number>((errorCount, err: Response) => {
                if (err.status < 500) {
                    throw err;
                }
                if (errorCount >= 10) {
                    throw err;
                }
                return errorCount + 1;
            }, 0).delay(400))
            .map<FunctionKeys>(r => {
                let keys: FunctionKeys = r.json();
                if (keys && Array.isArray(keys.keys)) {
                    keys.keys.unshift({
                        name: '_master',
                        value: this.masterKey
                    });
                }
                return keys;
            })
            .do(_ => {
                    this.isMultiKeySupported = true;
                    this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveRuntimeKey);
                },
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        if (error.status === 404) {
                            this.isMultiKeySupported = false;
                            this.legacyGetHostSecrets();
                            return Observable.of({keys: [], links: []});
                        }

                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToRetrieveRuntimeKey),
                            errorId: ErrorIds.unableToRetrieveRuntimeKey,
                            errorLevel: ErrorLevel.Fatal
                        });

                        this.trackEvent(ErrorIds.unableToRetrieveRuntimeKey, {
                            status: error.status.toString(),
                            content: error.text(),
                        });
                    }
                });
    }

    @Cache()
    getBindingConfig(): Observable<BindingConfig> {
        try {
            if (localStorage.getItem('dev-bindings')) {
                let devBindings: BindingConfig = JSON.parse(localStorage.getItem('dev-bindings'));
                this.localize(devBindings);
                return Observable.of(devBindings);
            }
        } catch (e) {
            console.error(e);
        }

        let url = Constants.serviceHost + 'api/bindingconfig?runtime=' + this._globalStateService.ExtensionVersion;

        return this._http.get(url, { headers: this.getPortalHeaders() })
            .retryWhen(this.retryAntares)
            .map<BindingConfig>(r => {
                let object = r.json();
                this.localize(object);
                return object;
            });
    }

    getResources(): Observable<any> {
        let runtime = this._globalStateService.ExtensionVersion ? this._globalStateService.ExtensionVersion : 'default';

        if (this._userService.inIFrame) {
            return this._userService.getLanguage()
                .flatMap((language: string) => {
                    return this.getLocalizedResources(language, runtime);
                });

        } else {
            return this.getLocalizedResources('en', runtime);
        }
    }

    get HostSecrets() {
        return this.masterKey;
    }

    getTrialResource(provider?: string): Observable<UIResource> {
        let url = this.tryAppServiceUrl + '/api/resource?appServiceName=Function'
            + (provider ? '&provider=' + provider : '');

        return this._http.get(url, { headers: this.getTryAppServiceHeaders() })
            .retryWhen(this.retryGetTrialResource)
            .map<UIResource>(r => r.json());
    }

    createTrialResource(selectedTemplate: FunctionTemplate, provider: string, functionName: string): Observable<UIResource> {
        let url = this.tryAppServiceUrl + '/api/resource?appServiceName=Function'
            + (provider ? '&provider=' + provider : '')
            + '&templateId=' + encodeURIComponent(selectedTemplate.id)
            + '&functionName=' + encodeURIComponent(functionName);

        let template = <ITryAppServiceTemplate>{
            name: selectedTemplate.id,
            appService: 'Function',
            language: selectedTemplate.metadata.language,
            githubRepo: ''
        };

        return this._http.post(url, JSON.stringify(template), { headers: this.getTryAppServiceHeaders() })
            .retryWhen(this.retryCreateTrialResource)
            .map<UIResource>(r => r.json());
    }

    updateFunction(fi: FunctionInfo) {
        ClearAllFunctionCache(fi);
        return this._http.put(fi.href, JSON.stringify(fi), { headers: this.getScmSiteHeaders() })
            .map<FunctionInfo>(r => r.json())
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToUpdateFunction + fi.name),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToUpdateFunction, { functionName: fi.name }),
                            errorId: ErrorIds.unableToUpdateFunction + fi.name,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToUpdateFunction, {
                            status: error.status.toString(),
                            content: error.text(),
                        });
                    }
                });
    }

    getFunctionErrors(fi: FunctionInfo) {
        return this.isEasyAuthEnabled
            ? Observable.of([])
            : this._http.get(`${this.mainSiteUrl}/admin/functions/${fi.name}/status`, { headers: this.getMainSiteHeaders() })
                .retryWhen(this.retryAntares)
                .map<string[]>(r => r.json().errors || [])
                .catch<string[]>(e => Observable.of(null));
    }

    getHostErrors() {
        if (this.isEasyAuthEnabled || !this.masterKey) {
            return Observable.of([]);
        } else {
            return this._http.get(`${this.mainSiteUrl}/admin/host/status`, { headers: this.getMainSiteHeaders() })
                .retryWhen(e => e.scan<number>((errorCount, err) => {
                    // retry 12 times with 5 seconds delay. This would retry for 1 minute before throwing.
                    if (errorCount >= 10) {
                        throw err;
                    }
                    return errorCount + 1;
                }, 0).delay(2000))
                .map<string[]>(r => r.json().errors || [])
                .do(r => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.functionRuntimeIsUnableToStart),
                    (error: FunctionsResponse) => {
                        if (!error.isHandled) {
                            this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                                message: this._translateService.instant(PortalResources.error_functionRuntimeIsUnableToStart),
                                errorId: ErrorIds.functionRuntimeIsUnableToStart,
                                errorLevel: ErrorLevel.RuntimeError
                            });
                            this.trackEvent(ErrorIds.functionRuntimeIsUnableToStart, {
                                status: error.status.toString(),
                                content: error.text(),
                            });
                        }
                    });
        }
    }

    @Cache()
    getFunctionHostId() {
        if (this.isEasyAuthEnabled || !this.masterKey) {
            return Observable.of('');
        } else {
            return this._http.get(`${this.mainSiteUrl}/admin/host/status`, { headers: this.getMainSiteHeaders() })
                .map<string>(r => r.json().id)
                .catch(e => Observable.of(''));
        }
    }

    getFunctionAppArmId() {
        if (this.functionContainer && this.functionContainer.id && this.functionContainer.id.trim().length !== 0) {
            return this.functionContainer.id;
        } else if (this._scmUrl) {
            return this._scmUrl;
        } else {
            return 'Unknown';
        }
    }

    setEasyAuth(config: { [key: string]: any }) {
        this.isEasyAuthEnabled = config['enabled'] && config['unauthenticatedClientAction'] !== 1;
    }

    getOldLogs(fi: FunctionInfo, range: number): Observable<string> {
        let url = `${this._scmUrl}/api/vfs/logfiles/application/functions/function/${fi.name}/`;
        return this._http.get(url, { headers: this.getScmSiteHeaders() })
            .catch(e => Observable.of({ json: () => [] }))
            .flatMap<string>(r => {
                let files: any[] = r.json();
                if (files.length > 0) {
                    let headers = this.getScmSiteHeaders();
                    headers.append('Range', `bytes=-${range}`);

                    files
                        .map(e => { e.parsedTime = new Date(e.mtime); return e; })
                        .sort((a, b) => a.parsedTime.getTime() - b.parsedTime.getTime());

                    return this._http.get(files.pop().href, { headers: headers })
                        .map<string>(f => {
                            let content = f.text();
                            let index = content.indexOf('\n');
                            return index !== -1
                                ? content.substring(index + 1)
                                : content;
                        });
                } else {
                    return Observable.of('');
                }
            });
    }

    @Cache('href')
    getVfsObjects(fi: FunctionInfo | string) {
        let href = typeof fi === 'string' ? fi : fi.script_root_path_href;
        return this._http.get(href, { headers: this.getScmSiteHeaders() })
            .map<VfsObject[]>(e => e.json())
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveDirectoryContent),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToRetrieveDirectoryContent),
                            errorId: ErrorIds.unableToRetrieveDirectoryContent,
                            errorLevel: ErrorLevel.ApiError
                        });
                        this.trackEvent(ErrorIds.unableToRetrieveDirectoryContent, {
                            content: error.text(),
                            status: error.status.toString()
                        });
                    }
                });
    }

    @ClearCache('clearAllCachedData')
    clearAllCachedData() { }

    getLatestRuntime() {
        return this._http.get(Constants.serviceHost + 'api/latestruntime', { headers: this.getPortalHeaders() })
            .map(r => {
                return r.json();
            })
            .retryWhen(this.retryAntares);
    }

    getLatestRoutingExtensionVersion() {
        return this._http.get(Constants.serviceHost + 'api/latestrouting', { headers: this.getPortalHeaders() })
            .map(r => {
                return r.json();
            })
            .retryWhen(this.retryAntares);
    }

    @Cache('href')
    getFunctionKeys(functionInfo: FunctionInfo): Observable<FunctionKeys> {
        return this._http.get(`${this.mainSiteUrl}/admin/functions/${functionInfo.name}/keys`, { headers: this.getMainSiteHeaders() })
            .retryWhen(this.retryAntares)
            .map<FunctionKeys>(r => r.json())
            .do(r => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRetrieveFunctionKeys + functionInfo.name),
                (error: FunctionsResponse) => {
                if (!error.isHandled) {
                    this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                        message: this._translateService.instant(PortalResources.error_unableToRetrieveFunctionKeys, { functionName: functionInfo.name }),
                        errorId: ErrorIds.unableToRetrieveFunctionKeys + functionInfo.name,
                        errorLevel: ErrorLevel.RuntimeError
                    });
                    this.trackEvent(ErrorIds.unableToRetrieveFunctionKeys, {
                        status: error.status.toString(),
                        content: error.text(),
                        functionName: functionInfo.name
                    });
                }
            });
    }

    @ClearCache('clearAllFunction', 'getFunctionKeys')
    @ClearCache('clearAllFunction', 'getFunctionHostKeys')
    createKey(keyName: string, keyValue: string, functionInfo?: FunctionInfo) {
        let url = functionInfo
            ? `${this.mainSiteUrl}/admin/functions/${functionInfo.name}/keys/${keyName}`
            : `${this.mainSiteUrl}/admin/host/keys/${keyName}`;

        let result: Observable<FunctionKey>;
        if (keyValue) {
            let body = {
                name: keyName,
                value: keyValue
            };
            result =  this._http.put(url, JSON.stringify(body), { headers: this.getMainSiteHeaders() })
                .retryWhen(this.retryAntares)
                .map<FunctionKey>(r => r.json());
        } else {
            result = this._http.post(url, '', { headers: this.getMainSiteHeaders() })
                .retryWhen(this.retryAntares)
                .map<FunctionKey>(r => r.json());
        }
        return result
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToCreateFunctionKey + functionInfo + keyName),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToCreateFunctionKey, { functionName: functionInfo.name, keyName: keyName }),
                            errorId: ErrorIds.unableToCreateFunctionKey + functionInfo + keyName,
                            errorLevel: ErrorLevel.RuntimeError
                        });
                        this.trackEvent(ErrorIds.unableToCreateFunctionKey, {
                            status: error.status.toString(),
                            content: error.text(),
                            functionName: functionInfo.name,
                            keyName: keyName
                        });
                    }
                });
    }

    @ClearCache('clearAllFunction', 'getFunctionKeys')
    @ClearCache('clearAllFunction', 'getFunctionHostKeys')
    deleteKey(key: FunctionKey, functionInfo?: FunctionInfo) {
        let url = functionInfo
            ? `${this.mainSiteUrl}/admin/functions/${functionInfo.name}/keys/${key.name}`
            : `${this.mainSiteUrl}/admin/host/keys/${key.name}`;

        return this._http.delete(url, { headers: this.getMainSiteHeaders() })
            .retryWhen(this.retryAntares)
            .do(_ => this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToDeleteFunctionKey + functionInfo + key.name),
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToDeleteFunctionKey, { functionName: functionInfo.name, keyName: key.name }),
                            errorId: ErrorIds.unableToDeleteFunctionKey + functionInfo + key.name,
                            errorLevel: ErrorLevel.RuntimeError
                        });
                        this.trackEvent(ErrorIds.unableToDeleteFunctionKey, {
                            status: error.status.toString(),
                            content: error.text(),
                            functionName: functionInfo.name,
                            keyName: key.name
                        });
                    }
                });
    }

    @ClearCache('clearAllFunction', 'getFunctionKeys')
    @ClearCache('clearAllFunction', 'getFunctionHostKeys')
    renewKey(key: FunctionKey, functionInfo?: FunctionInfo) {
        let url = functionInfo
            ? `${this.mainSiteUrl}/admin/functions/${functionInfo.name}/keys/${key.name}`
            : `${this.mainSiteUrl}/admin/host/keys/${key.name}`;
        return this._http.post(url, '', { headers: this.getMainSiteHeaders() })
            .retryWhen(this.retryAntares)
            .do(r => {
                   this._broadcastService.broadcast<string>(BroadcastEvent.ClearError, ErrorIds.unableToRenewFunctionKey + functionInfo + key.name);
                   if (!functionInfo && key.name === '_master') {
                       this.masterKey = r.json().value;
                   }
                },
                (error: FunctionsResponse) => {
                    if (!error.isHandled) {
                        this._broadcastService.broadcast<ErrorEvent>(BroadcastEvent.Error, {
                            message: this._translateService.instant(PortalResources.error_unableToRenewFunctionKey, { functionName: functionInfo.name, keyName: key.name }),
                            errorId: ErrorIds.unableToRenewFunctionKey + functionInfo + key.name,
                            errorLevel: ErrorLevel.RuntimeError
                        });
                        this.trackEvent(ErrorIds.unableToRenewFunctionKey, {
                            status: error.status.toString(),
                            content: error.text(),
                            functionName: functionInfo.name,
                            keyName: key.name
                        });
                    }
                });
    }

    fireSyncTrigger() {
        let url = `${this._scmUrl}/api/functions/synctriggers`;
        this._http.post(url, '', { headers: this.getScmSiteHeaders() })
            .subscribe(success => console.log(success), error => console.log(error));
    }

    @Cache()
    getJson(uri: string) {
        return this._http.get(uri, { headers: this.getMainSiteHeaders() })
            .map<FunctionKeys>(r => r.json());
    }

    diagnose() {
        if (this.functionContainer && this.functionContainer.id && this.functionContainer.id.trim().length !== 0) {
            this._http.post(Constants.serviceHost + `api/diagnose${this.functionContainer.id}`, this.getPortalHeaders())
                .subscribe(s => console.log(s.json()), e => console.log(e));
        }
    }

    // to talk to scm site
    private getScmSiteHeaders(contentType?: string): Headers {
        contentType = contentType || 'application/json';
        let headers = new Headers();
        headers.append('Content-Type', contentType);
        headers.append('Accept', 'application/json,*/*');
        if (!this._globalStateService.showTryView && this.token) {
            headers.append('Authorization', `Bearer ${this.token}`);
        }
        if (this._globalStateService.ScmCreds) {
            headers.append('Authorization', `Basic ${this._globalStateService.ScmCreds}`);
        }
        return headers;
    }

    private getMainSiteHeaders(contentType?: string): Headers {
        contentType = contentType || 'application/json';
        let headers = new Headers();
        headers.append('Content-Type', contentType);
        headers.append('Accept', 'application/json,*/*');
        headers.append('x-functions-key', this.masterKey);
        return headers;
    }

    // to talk to Functions Portal
    private getPortalHeaders(contentType?: string): Headers {
        contentType = contentType || 'application/json';
        let headers = new Headers();
        headers.append('Content-Type', contentType);
        headers.append('Accept', 'application/json,*/*');

        if (this.token) {
            headers.append('client-token', this.token);
            headers.append('portal-token', this.token);
        }

        return headers;
    }

    // to talk to TryAppservice
    private getTryAppServiceHeaders(contentType?: string): Headers {
        contentType = contentType || 'application/json';
        let headers = new Headers();
        headers.append('Content-Type', contentType);
        headers.append('Accept', 'application/json,*/*');

        if (this._globalStateService.TryAppServiceToken) {
            headers.append('Authorization', `Bearer ${this._globalStateService.TryAppServiceToken}`);
        } else {
            headers.append('ms-x-user-agent', 'Functions/');
        }
        return headers;
    }

    private localize(objectTolocalize: any) {
        if ((typeof value === 'string') && (value.startsWith('$'))) {
            objectTolocalize[property] = this._translateService.instant(value.substring(1, value.length));
        }

        for (var property in objectTolocalize) {

            if (property === 'files' || property === 'defaultValue') {
                continue;
            }

            if (objectTolocalize.hasOwnProperty(property)) {
                var value = objectTolocalize[property];
                if ((typeof value === 'string') && (value.startsWith('$'))) {
                    var key = value.substring(1, value.length);
                    var locString = this._translateService.instant(key);
                    if (locString !== key) {
                        objectTolocalize[property] = locString;
                    }
                }
                if (Array.isArray(value)) {
                    for (var i = 0; i < value.length; i++) {
                        this.localize(value[i]);
                    }
                }
                if (typeof value === 'object') {
                    this.localize(value);
                }
            }
        }
    }

    private getLocalizedResources(lang: string, runtime: string): Observable<any> {
        return this._http.get(Constants.serviceHost + `api/resources?name=${lang}&runtime=${runtime}`, { headers: this.getPortalHeaders() })
            .retryWhen(this.retryAntares)
            .map<any>(r => {
                let resources = r.json();

                this._translateService.setDefaultLang('en');
                this._translateService.setTranslation('en', resources.en);
                if (resources.lang) {
                    this._translateService.setTranslation(lang, resources.lang);
                }
                this._translateService.use(lang);
            });
    }

    private retryAntares(error: Observable<any>): Observable<any> {
        return error.scan<number>((errorCount, err: FunctionsResponse) => {
            if (err.isHandled || err.status < 500 || errorCount >= 10) {
                throw err;
            } else {
                return errorCount + 1;
            }
        }, 0).delay(1000);
    }

    private retryCreateTrialResource(error: Observable<any>): Observable<any> {
        return error.scan<number>((errorCount, err: Response) => {
            // 400 => you already have a resource, 403 => No login creds provided
            if (err.status === 400 || err.status === 403 || errorCount >= 10) {
                throw err;
            } else {
                return errorCount + 1;
            }
        }, 0).delay(1000);
    }

    private retryGetTrialResource(error: Observable<any>): Observable<any> {
        return error.scan<number>((errorCount, err: Response) => {
            // 403 => No login creds provided
            if (err.status === 403 || errorCount >= 10) {
                throw err;
            } else {
                return errorCount + 1;
            }
        }, 0).delay(1000);
    }

    private runFunctionInternal(response: Observable<Response>, functionInfo: FunctionInfo) {
        return response
            .catch((e: Response) => {
                if (this.isEasyAuthEnabled) {
                    return Observable.of({
                        status: 401,
                        statusText: this.statusCodeToText(401),
                        text: () => this._translateService.instant(PortalResources.functionService_authIsEnabled)
                    });
                } else if (e.status === 200 && e.type === ResponseType.Error) {
                    return Observable.of({
                        status: 502,
                        statusText: this.statusCodeToText(502),
                        text: () => this._translateService.instant(PortalResources.functionService_errorRunningFunc, {
                            name: functionInfo.name
                        })
                    });
                } else if (e.status === 0 && e.type === ResponseType.Error) {
                    return Observable.of({
                        status: 0,
                        statusText: this.statusCodeToText(0),
                        text: () => ''
                    });
                } else {
                    return Observable.of({
                        status: e.status,
                        statusText: this.statusCodeToText(e.status),
                        text: () => ''
                    });
                }
            })
            .map<RunFunctionResult>(r => ({ statusCode: r.status, statusText: this.statusCodeToText(r.status), content: r.text() }));
    }

    /**
     * returns the file name from a VfsObject or an href
     * @param file either a VfsObject or a string representing the file's href.
     */
    private getFileName(file: VfsObject | string): string {
        if (typeof file === 'string') {
         // if `file` is a string, that means it's in the format:
         //     https://<scmUrl>/api/vfs/path/to/file.ext
            return  file
                    .split('/') // [ 'https:', '', '<scmUrl>', 'api', 'vfs', 'path', 'to', 'file.ext' ]
                    .pop(); // 'file.ext'
        } else {
            return file.name;
        }
    }


    /**
     * This function is just a wrapper around AiService.trackEvent. It injects default params expected from this class.
     * Currently that's only scmUrl
     * @param params any additional parameters to get added to the default parameters that this class reports to AppInsights
     */
    private trackEvent(name: string, params: {[name: string]: string}) {
        let standardParams = {
            scmUrl: this._scmUrl
        };

        for (let key in params) {
            if (params.hasOwnProperty(key)) {
                standardParams[key] = params[key];
            }
        }

        this._aiService.trackEvent(name, standardParams);
    }
}
