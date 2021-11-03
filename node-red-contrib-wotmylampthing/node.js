module.exports = function (RED) {
    "use strict";
    const request = require('request');
    const url = require('url');
    const HttpsProxyAgent = require('https-proxy-agent');
    const WebSocket = require('ws');
    const urltemplate = require('url-template');
    const Ajv = require('ajv').default;
    const nodecoap = require('coap');

    function extractTemplate(href, context={}) {
        return urltemplate.parse(href).expand(context);
    }

    function getResType(form) {
        if (form) {
            if (form.response && form.response.contentType) {
                return form.response.contentType;
            } else if (form.contentType) {
                return form.contentType;
            }
        }
        return "application/json";
    }

    function isBinaryType(contentType) {
        let result;
        switch (contentType) {
            case "image/jpeg":
            case "application/octet-stream":
                result = true;
                break;
            default:
                result = false;
                break;
        }
        return result;
    }

    function coapMethodCodeToName(methodCode) {
        switch (methodCode) {
            case '1':
            case '0.01':
            case 'get':
            case 'GET':
                return 'get';
                break;
            case '2':
            case '0.02':
            case 'post':
            case 'POST':
                return 'post';
                break;
            case '3':
            case '0.03':
            case 'put':
            case 'PUT':
                return 'put';
                break;
            case '4':
            case '0.04':
            case 'delete':
            case 'DELETE':
                return 'delete';
                break;
            default:
                return 'get';
                break;
        }
    }

    function createCoapReqOpts(resource, method, observe=false) {
        let urlobj = new URL(resource);
        let hostname = urlobj.hostname;
        if (hostname.startsWith('[') && hostname.endsWith(']')) {
            // remove square brackets from IPv6 address
            hostname = hostname.slice(1,-1);
        }
        let query = urlobj.search;
        if (query.startsWith('?')) {
            query = query.slice(1);
        }
        return {
            hostname: hostname,
            port: urlobj.port,
            method: method,
            pathname: urlobj.pathname,
            query: query,
            observe: observe
        };
    }

    function bindingCoap(node, send, done, form, options={}) { // options.psk
        node.trace("bindingCoap called");
        const msg = options.msg || {};
        const resource = extractTemplate(form.href, options.urivars);
        let payload = null;
        let method = null;
        if (options.interaction === "property-read") {
            method = form.hasOwnProperty("cov:methodName") ?
                coapMethodCodeToName(form['cov:methodName']) : 'get';
        } else if (options.interaction === "property-write") {
            method = form.hasOwnProperty("cov:methodName") ?
                coapMethodCodeToName(form['cov:methodName']) : 'put';
            payload = options.reqbody;
        } else { // assume "action"
            method = form.hasOwnProperty("cov:methodName") ?
                coapMethodCodeToName(form['cov:methodName']) : 'post';
            payload = options.reqbody;
        }

        const coapreqopt = createCoapReqOpts(resource, method, false);

        node.trace(`CoAP request: reqopt=${JSON.stringify(coapreqopt)},payload=${payload}`);
        let outmsg = nodecoap.request(coapreqopt);
        if (payload) {
            outmsg.write(payload);
        }
        outmsg.on('response', response => {
            const cf = response.options.find(e=>e.name === 'Content-Format');
            if (cf && cf.value === 'application/json') {
                try {
                    msg.payload = JSON.parse(response.payload.toString());
                    if (options.outschema) {
                        const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                        if (!ajv.validate(options.outschema, msg.payload)) {
                            node.warn(`output schema validation error: ${ajv.errorsText()}`, msg);
                        }
                    }
                } catch (e) {
                    msg.payload = response.payload;
                }
            } else if (cf && cf.value === 'text/plain') {
                msg.payload = response.payload.toString();   
            } else {
                msg.payload = response.payload;
            }
            send(msg);
            response.on('end', () => { if (done) { done(); }});
        });
        const errorHandler = (err) => {
            node.warn(`CoAP request error: ${err.message}`);
            delete msg.payload;
            msg.error = err;
            send(msg);
            if (done) { done() }; 
        };
        outmsg.on('timeout', errorHandler);
        outmsg.on('error', errorHandler);
        outmsg.end();
    }

    function bindingCoapObserve(node, form, options={}) {
        node.status({fill:"yellow",shape:"dot",text:"CoAP try to observe ..."});
        const resource = extractTemplate(form.href,options.urivars);
        const method = form.hasOwnProperty("cov:methodName") ?
            coapMethodCodeToName(form['cov:methodName']) : 'get';
        const payload = options.reqbody;
        let observingStream;

        const coapreqopt = createCoapReqOpts(resource, method, true);
        node.trace(`CoAP observe request: reqopt=${JSON.stringify(coapreqopt)},payload=${payload}`);

        let outmsg = nodecoap.request(coapreqopt);
        if (payload) {
            outmsg.write(payload);
        }
        outmsg.on('response', response => {
            observingStream = response;
            const cf = response.options.find(e=>e.name === 'Content-Format');
            response.on('end', () => {});
            response.on('data', chunk => {
                const msg = {};
                if (cf && cf.value === 'application/json') {
                    try {
                        msg.payload = JSON.parse(chunk.toString());
                        if (options.outschema) {
                            const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                            if (!ajv.validate(options.outschema, msg.payload)) {
                                node.warn(`output schema validation error: ${ajv.errorsText()}`, msg);
                            }
                        }
                    } catch (e) {
                        msg.payload = chunk;
                    }
                } else if (cf && cf.value === 'text/plain') {
                    msg.payload = chunk.toString();
                } else {
                    msg.payload = chunk;
                }
                node.send(msg);
            });
        });
        const errorHandler = (err) => {
            node.warn(`CoAP request error: ${err.message}`);
            node.status({fill:'red',shape:'dot',text:`CoAP Error: ${err}`});
            delete msg.payload;
            msg.error = err;
            node.send(msg); 
        };
        outmsg.on('timeout', errorHandler);
        outmsg.on('error', errorHandler);
        outmsg.end();
        node.status({fill:'green',shape:'dot',text:'CoAP Observing'});
        node.on('close', () => {
            node.trace('Close node');
            if (observingStream) {
                observingStream.close();
                observingStream = null;
            };
            node.status({});
        });
    }

    function bindingWebSocket(node, form, options={}) {
        let ws;
        let reconnectTimeout;
        let needReconnect = false;
        const setupWsClient = () => {
            let wsoptions = {};
            if (process.env.http_proxy) {
                const agoptions = url.parse(process.env.http_proxy);
                const agent = new HttpsProxyAgent(agoptions);
                wsoptions = {agent: agent};
            }
            if (options.hasOwnProperty("auth") && 
                (options.auth.hasOwnProperty("user") || options.auth.hasOwnProperty("bearer"))) {
                wsoptions.auth = options.auth;
            }
            node.status({fill:"yellow",shape:"dot",text:"WS Connecting..."});
            needReconnect = true;
            const href = extractTemplate(form.href,options.urivars);
            ws = new WebSocket(href, wsoptions);
            node.trace(`Connecting websocket: ${form.href}`);

            ws.on('open', () => {
                node.status({fill:"green",shape:"dot",text:"WS Connected"});
                node.trace('websocket opened.');
            });
            ws.on('close', (code, reason) => {
                node.status({});
                node.trace(`websocket closed (code=${code}, reason=${reason})`); 
                if (needReconnect) {
                    node.status({fill:"orange",shape:"dot",text:`WS Reconnecting...`});
                    reconnectTimeout = setTimeout(setupWsClient, 5000);
                }
            });
            ws.on('error', (error) => {
                node.status({fill:"red",shape:"dot",text:`WS Error: ${error}`});
                node.warn(`websocket error: ${error}`);
            });
            ws.on('message', (data) => {
                node.status({fill:"green",shape:"dot",text:"WS OK"});
                const msg = {};
                if (getResType(form) === "application/json") {
                    try {
                        msg.payload = JSON.parse(data);
                    } catch(e) {
                        msg.payload = data;
                    }
                } else {
                    msg.payload = data;
                }
                if (options.outschema) {
                    const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                    if (!ajv.validate(options.outschema, msg.payload)) {
                        node.warn(`output schema validation error: ${ajv.errorsText()}`, msg);
                    }
                }     
                node.send(msg)
            });
        }
        setupWsClient();
        node.on('close', () => {
            node.trace('Close node');
            clearTimeout(reconnectTimeout);
            needReconnect = false;
            try {
                ws.close();
            } catch (err) {

            }
            node.status({});
        });
    }

    function bindingLongPoll(node, form, options={}) {
        let reqObj;
        let needReconnect = false;
        let reconnectTimeout;
        const setupLPClient = () => { 
            const reqoptions = {};
            reqoptions.uri = extractTemplate(form.href, options.urivars);
            reqoptions.rejectUnauthorized = false;
            // reqoptions.timeout = 60000; 
            if (options && options.auth && (options.auth.user || options.auth.bearer)) {
                reqoptions.auth = options.auth;
            }
            reqoptions.method = form.hasOwnProperty("htv:methodName") ? form["htv:methodName"] : "GET";
            if (isBinaryType(form.contentType)) {
                reqoptions.encoding = null;
            }
            node.trace(`LongPoll Request options: ${JSON.stringify(reqoptions)}`);
            needReconnect = true;
            reqObj = request(reqoptions, (err, res, body) => {
                if (err) {
                    const msg = {};
                    msg.payload = `${err.toString()}: ${reqoptions.uri}`;
                    msg.statusCode = err.code;
                    node.status({fill:"yellow",shape:"dot",text:"Polling error"});
                    node.send(msg);
                    if (needReconnect) {
                        reconnectTimeout = setTimeout(setupLPClient, 5000);
                    }
                } else {
                    const msg = {};
                    node.status({fill:"green",shape:"dot",text:"OK"});
                    msg.statusCode = res.statusCode;
                    msg.headers = res.headers;
                    msg.responseUrl = res.request.uri.href;
                    if (getResType(form) === "application/json") {
                        try {
                            msg.payload = JSON.parse(body);
                        } catch(e) {
                            msg.payload = body;
                        }
                    } else {
                        msg.payload = body;
                    }
                    // TODO: validation of return value
                    if (options.outschema) {
                        const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                        if (!ajv.validate(options.outschema, msg.payload)) {
                            node.warn(`output schema validation error: ${ajv.errorsText()}`, msg);
                        }
                    }     
                    node.send(msg);
                    if (needReconnect) {
                        reconnectTimeout = setTimeout(setupLPClient, 5000);
                    }
                }
            });
            node.status({fill:"green",shape:"dot",text:"Connecting..."});
        }
        setupLPClient();
        node.on("close", () => {
            node.status({});
            needReconnect = false;
            clearTimeout(reconnectTimeout);
            if (reqObj) {
                reqObj.abort();
            } 
        });
    }

    function bindingHttp(node, send, done, form, options={}) { // options.interaction, options.auth, options.reqbody, options.msg
        const msg = options.msg || {};
        const reqoptions = {}; 
        reqoptions.uri = extractTemplate(form.href, options.urivars);
        reqoptions.rejectUnauthorized = false;
        if (options.hasOwnProperty("auth") && 
            (options.auth.hasOwnProperty("user") || options.auth.hasOwnProperty("bearer"))) {
            reqoptions.auth = options.auth;
        }
        if (options.interaction === "property-read") {
            reqoptions.method = form.hasOwnProperty("htv:methodName") ? form["htv:methodName"] : "GET";
        } else if (options.interaction === "property-write") {
            reqoptions.method = form.hasOwnProperty("htv:methodName") ? form["htv:methodName"] : "PUT";
            switch (reqoptions.method) {
                case "GET":
                    break;
                case "POST":
                case "PUT":
                    reqoptions.json = form.contentType === "application/json";
                    reqoptions.body = options.reqbody;
                    reqoptions.headers = {'Content-Type': form.contentType};
                    break;
            }
        } else { // assume "action"
            reqoptions.method = form.hasOwnProperty("htv:methodName") ? form["htv:methodName"] : "POST";
            switch (reqoptions.method) {
                case "GET":
                    break;
                case "POST":
                case "PUT":
                    reqoptions.json = form.contentType === "application/json";
                    reqoptions.body = options.reqbody;
                    reqoptions.headers = {'Content-Type': form.contentType};
                    if (form.hasOwnProperty("response") && isBinaryType(form.response.contentType)) {
                        reqoptions.encoding = null;
                    }
                    break;
            }
        }
        if (isBinaryType(form.contentType)) {
            reqoptions.encoding = null;
        }
        node.trace(`HTTP request options: ${JSON.stringify(reqoptions)}`);
        request(reqoptions, (err, res, body) => {
            if (err) {
                node.log(`Error: ${err.toString()}`);
                msg.payload = `${err.toString()}: ${reqoptions.uri}`;
                msg.statusCode = err.code;
                send(msg); 
            } else {
                msg.statusCode = res.statusCode;
                msg.headers = res.headers;
                msg.responseUrl = res.request.uri.href;
                if (getResType(form) === "application/json") {
                    try {
                        msg.payload = JSON.parse(body);
                    } catch(e) {
                        msg.payload = body;
                    }
                } else {
                    msg.payload = body;
                }
                // TODO: validation of return value
                if (options.outschema) {
                    const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                    if (!ajv.validate(options.outschema, msg.payload)) {
                        node.warn(`output schema validation error: ${ajv.errorsText()}`, msg);
                    }
                }    
                send(msg); 
            }
            if (done) {
                done();
            }
        });
    }

    function makeauth(td, form, username, password, token) {
        const scheme = td.securityDefinitions[form.security].scheme;
        const auth = {};
        switch (scheme) {
            case "basic":
                auth.user = username;
                auth.pass = password;
                auth.sendImmediately = true;
                break;
            case "digest":
                auth.user = username;
                auth.pass = password;
                auth.sendImmediately = false;
                break;
            case "bearer":
                auth.bearer = token;
                break;
        }
        return auth;
    }

    function Node(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        node.interactiontype = config.interactiontype;
        node.propname = config.propname;
        node.proptype = config.proptype;
        node.actname = config.actname;
        node.evname = config.evname;
        node.formindex = config.formindex;
        node.status({});
        node.debug(`node config: ${JSON.stringify(node)}`);
        const username = node.credentials.username;
        const password = node.credentials.password;
        const token = node.credentials.token;
     
        node.td = {"@context":["https://www.w3.org/2019/wot/td/v1",{"saref":"https://w3id.org/saref#"}],"id":"urn:dev:ops:32473-WoTLamp-1234","title":"MyLampThing","@type":"saref:LightSwitch","securityDefinitions":{"basic_sc":{"scheme":"basic","in":"header"}},"security":["basic_sc"],"properties":{"status":{"@type":"saref:OnOffState","type":"string","forms":[{"href":"https://mylamp.example.com/status"}]}},"actions":{"toggle":{"@type":"saref:ToggleCommand","forms":[{"href":"https://mylamp.example.com/toggle"}]}},"events":{"overheating":{"data":{"type":"string"},"forms":[{"href":"https://mylamp.example.com/oh"}]}}};
        const normTd = {"@context":["https://www.w3.org/2019/wot/td/v1",{"saref":"https://w3id.org/saref#"}],"id":"urn:dev:ops:32473-WoTLamp-1234","title":"MyLampThing","@type":"saref:LightSwitch","securityDefinitions":{"basic_sc":{"scheme":"basic","in":"header"}},"security":["basic_sc"],"properties":{"status":{"@type":"saref:OnOffState","type":"string","forms":[{"href":"https://mylamp.example.com/status","security":["basic_sc"],"contentType":"application/json","op":["readproperty","writeproperty"]}],"writeOnly":false,"readOnly":false,"observable":false}},"actions":{"toggle":{"@type":"saref:ToggleCommand","forms":[{"href":"https://mylamp.example.com/toggle","security":["basic_sc"],"contentType":"application/json","op":"invokeaction"}],"safe":false,"idempotent":false}},"events":{"overheating":{"data":{"type":"string"},"forms":[{"href":"https://mylamp.example.com/oh","security":["basic_sc"],"contentType":"application/json","op":"subscribeevent"}]}}};
        if (node.interactiontype === "property") {
            if (node.proptype === "read") {
                node.on("input", (msg, send, done) => {
                    send = send || function() { node.send.apply(node,arguments) };
                    const prop = normTd.properties[node.propname];
                    const form = prop.forms[node.formindex];// formSelection("property-read", prop.forms);
                    const auth = makeauth(normTd, form, username, password, token);
                    const urivars = prop.hasOwnProperty("uriVariables") ? msg.payload : {};
                    if (prop.uriVariables) {
                        const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                        if (!ajv.validate(prop.uriVariables, urivars)) {
                            node.warn(`input schema validation error: ${ajv.errorsText()}`, msg);
                        }
                    }
                    if (form.href.match(/^https?:/)) {
                        bindingHttp(node, send, done, form, {interaction:"property-read", auth, msg, urivars, outschema: prop});
                    } else if (form.href.match(/^coaps?:/)) {
                        bindingCoap(node, send, done, form, {interaction:"property-read", auth, msg, urivars, outschema: prop});
                    }
                });
            } else if (node.proptype === "write") {
                node.on("input", (msg, send, done) => {
                    send = send || function() { node.send.apply(node,arguments) };
                    const prop = normTd.properties[node.propname];
                    const form = prop.forms[node.formindex];// formSelection("property-write", prop.forms);
                    const auth = makeauth(normTd, form, username, password, token);
                    const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                    if (!ajv.validate(prop, msg.payload)) {
                        node.warn(`input schema validation error: ${ajv.errorsText()}`, msg);
                    }
                    // URI template is not supported, because 'write' doesn't use GET method.
                    if (form.href.match(/^https?:/)) {
                        bindingHttp(node, send, done, form, {interaction: "property-write", auth, msg, reqbody: msg.payload}); 
                    } else if (form.href.match(/^coaps?:/)) {
                        bindingCoap(node, send, done, form, {interaction: "property-write", auth, msg, reqbody: msg.payload}); 
                    }
                });
            } else if (node.proptype === "observe") {
                const prop = normTd.properties[node.propname];
                const form = prop.forms[node.formindex];// formSelection("property-observe", prop.forms);
                const auth = makeauth(normTd, form, username, password, token);
                const urivars = prop.hasOwnProperty("uriVariables") ? msg.payload : {};
                if (prop.uriVariables) {
                    const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                    if (!ajv.validate(prop.uriVariables, urivars)) {
                        node.warn(`input schema validation error: ${ajv.errorsText()}`, msg);
                    }
                }
                if (form.href.match(/^wss?:/)) { // websocket
                    bindingWebSocket(node, form, {auth, urivars, outschema: prop});
                } else if (form.href.match(/^coaps?:/)) { // CoAP observe
                    bindingCoapObserve(node, form, {auth, urivars, outschema: prop});
                } else { // long polling
                    bindingLongPoll(node, form, {auth, urivars, outschema: prop});
                }               
            }
        } else if (node.interactiontype === "action") {
            node.on("input", (msg, send, done) => {
                send = send || function() { node.send.apply(node,arguments) };
                const act = normTd.actions[node.actname];
                const form = act.forms[node.formindex];// formSelection("action", act.forms);
                const auth = makeauth(normTd, form, username, password, token);
                const urivars = act.hasOwnProperty("uriVariables") ? msg.payload : {};
                if (act.uriVariables) {
                    const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                    if (!ajv.validate(act.uriVariables, urivars)) {
                        node.warn(`input schema validation error: ${ajv.errorsText()}`, msg);
                    }
                }
                if (act.input) {
                    const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                    if (!ajv.validate(act.input, msg.payload)) {
                        node.warn(`input schema validation error: ${ajv.errorsText()}`, msg);
                    }
                }
                if (form.href.match(/^https?:/)) {
                    bindingHttp(node, send, done, form, {interaction: "action", auth, msg, urivars, reqbody:msg.payload});
                } else if (form.href.match(/^coaps?/)) {
                    bindingCoap(node, send, done, form, {interaction: "action", auth, msg, urivars, reqbody:msg.payload});
                }                
            });
        } else if (node.interactiontype === "event") {
            const ev = normTd.events[node.evname];
            const form = ev.forms[node.formindex];// formSelection("event", ev.forms);
            const auth = makeauth(normTd, form, username, password, token);
            const urivars = ev.hasOwnProperty("uriVariables") ? msg.payload : {};
            if (ev.uriVariables) {
                const ajv = new Ajv({allErrors: true, strict: false, validateFormats: false});
                if (!ajv.validate(ev.uriVariables, urivars)) {
                    node.warn(`input schema validation error: ${ajv.errorsText()}`, msg);
                }
            }
            if (form.href.match(/^wss?:/)) { // websocket
                bindingWebSocket(node, form, {auth, urivars});
            } else if (form.href.match(/^coaps?:/)) {
                bindingCoapObserve(node, form, {auth, urivars});
            } else { // long polling
                bindingLongPoll(node, form, {auth, urivars});
            }               
        }
    }
    
    RED.nodes.registerType("wotmylampthing", Node, {
        credentials: {
            token: {type:"password"},
            username: {type:"text"},
            password: {type:"password"}
        }
    });
};