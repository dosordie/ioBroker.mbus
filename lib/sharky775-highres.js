'use strict';

const net = require('net');
const p = require('./device-profiles/sharky775-r4.json');

let adapter;
let installed = false;
const scaling = new Map();
const supported = new Map();
const errors = new Map();

function install() {
    if (installed) return;
    installed = true;
    const utils = require('@iobroker/adapter-core');
    const MbusMaster = require('node-mbus');
    const oldOn = utils.Adapter.prototype.on;
    utils.Adapter.prototype.on = function (name, fn) {
        if (!adapter && (this.name === 'mbus' || String(this.namespace || '').startsWith('mbus.'))) adapter = this;
        return oldOn.call(this, name, fn);
    };
    const oldGetData = MbusMaster.prototype.getData;
    const oldClose = MbusMaster.prototype.close;
    MbusMaster.prototype.getData = function (id, cb) {
        return oldGetData.call(this, id, (err, data) => {
            this.__sharkyPending = !err && candidate(data) ? {id: String(id), data} : null;
            cb(err, data);
        });
    };
    MbusMaster.prototype.close = function (cb) {
        const pending = this.__sharkyPending;
        this.__sharkyPending = null;
        return oldClose.call(this, err => {
            if (err || !pending || !adapter) return cb && cb(err);
            readCycle(adapter, pending).catch(e => logError(adapter, pending.id, e)).then(() => cb && cb(err));
        });
    };
}

function candidate(data) {
    const i = data && data.SlaveInformation;
    if (!i) return false;
    const m = String(i.Manufacturer || '').toUpperCase();
    if (p.autoDetect.manufacturers.includes(m)) return true;
    return [i.ProductName, i.Product, i.DeviceType, i.Type].filter(Boolean).join(' ').toLowerCase().includes('sharky 775');
}

async function readCycle(a, pending) {
    if (!a.config || a.config.type !== 'tcp' || !a.config.host || !a.config.port) return;
    const cfg = Array.isArray(a.config.devices) ? a.config.devices.find(d => String(d.id) === pending.id) : null;
    if (cfg && (cfg.sharkyHighResolution === false || cfg.deviceProfile === 'off')) return;
    const ns = pending.data.SlaveInformation.Manufacturer + '-' + pending.data.SlaveInformation.Id;
    const enabledId = ns + '.data.' + p.output.enabledState;
    if (supported.get(ns) && !(await isEnabled(a, enabledId))) return;
    const timeout = Number(a.config.tcpTimeout) >= 500 ? Number(a.config.tcpTimeout) : 3000;
    const s = await connect(a.config.host, Number(a.config.port), timeout);
    try {
        const target = await address(s, pending.id, timeout);
        let sc = scaling.get(ns);
        if (!sc) {
            sc = await readScaling(s, target, timeout);
            scaling.set(ns, sc);
        }
        const raw = await readMem(s, target, p.values.ZVENAKK.address, p.values.ZVENAKK.length, timeout);
        const wh = energyWh(raw, sc);
        supported.set(ns, true);
        errors.delete(pending.id);
        await ensureStates(a, ns, sc);
        await setState(a, ns + '.data.' + p.output.state, wh, true);
        a.log && a.log.debug('SHARKY 775 ' + ns + ' high-resolution energy: ' + wh + ' Wh');
    } finally {
        s.destroy();
    }
}

async function readScaling(s, target, timeout) {
    const zRaw = (await readMem(s, target, p.values.ZCEINH.address, 1, timeout))[0];
    const kRaw = (await readMem(s, target, p.values.KOMMAE.address, 1, timeout))[0];
    const eRaw = (await readMem(s, target, p.values.ENAKCM.address, 1, timeout))[0];
    const zceinh = (zRaw & p.values.ZCEINH.mask) >> p.values.ZCEINH.shift;
    const kommae = kRaw & 0x80 ? kRaw - 256 : kRaw;
    const enakcm = eRaw & p.values.ENAKCM.mask;
    if (enakcm > 7) throw new Error('ENAKCM=' + enakcm + ' is not energy');
    if (kommae < 0 || kommae > 7) throw new Error('unexpected KOMMAE=' + kommae);
    if (zceinh < 0 || zceinh > 4) throw new Error('unsupported ZCEINH=' + zceinh);
    return {zceinh, kommae, enakcm};
}

function energyWh(bytes, sc) {
    const raw = Number(decodeBcd(bytes));
    const value = raw * Math.pow(10, -8 - sc.kommae);
    const factors = [1000, 1000000000 / 3600, 1055.05585262 * 1000000 / 3600, 4.184 * 1000000000 / 3600, 1000000];
    return Math.round(value * factors[sc.zceinh] * 1000000) / 1000000;
}

function decodeBcd(bytes) {
    let d = '';
    for (let i = bytes.length - 1; i >= 0; i--) {
        const h = bytes[i] >> 4, l = bytes[i] & 15;
        if (h > 9 || l > 9) throw new Error('invalid BCD in ZVENAKK');
        d += h + '' + l;
    }
    return BigInt(d.replace(/^0+(?=\d)/, '') || '0');
}

function connect(host, port, timeout) {
    return new Promise((resolve, reject) => {
        const s = net.createConnection({host, port});
        const t = setTimeout(() => { s.destroy(); reject(new Error('TCP connect timeout')); }, timeout);
        s.once('connect', () => { clearTimeout(t); s.setNoDelay(true); resolve(s); });
        s.once('error', e => { clearTimeout(t); reject(e); });
    });
}

async function address(s, id, timeout) {
    if (/^\d{1,3}$/.test(id) && Number(id) <= 250) return Number(id);
    const sec = id.replace(/\s+/g, '').toUpperCase();
    if (!/^[0-9A-F]{16}$/.test(sec)) throw new Error('unsupported M-Bus address ' + id);
    const f = longFrame(0x53, 0xFD, 0x52, packSecondary(sec));
    await exchange(s, f, r => r.length === 1 && r[0] === 0xE5, timeout);
    return 0xFD;
}

function packSecondary(x) {
    if (!/^\d{8}/.test(x)) throw new Error('secondary wildcard not supported');
    const b = Buffer.alloc(8);
    b[0] = parseInt(x.slice(6, 8), 16); b[1] = parseInt(x.slice(4, 6), 16);
    b[2] = parseInt(x.slice(2, 4), 16); b[3] = parseInt(x.slice(0, 2), 16);
    const m = parseInt(x.slice(8, 12), 16);
    b[4] = m >> 8; b[5] = m & 255; b[6] = parseInt(x.slice(12, 14), 16); b[7] = parseInt(x.slice(14, 16), 16);
    return b;
}

async function readMem(s, target, addr, len, timeout) {
    const payload = Buffer.from([0x2F, 0x0F, 0xB0, len, addr & 255, addr >> 8, 255, 255, 255, 255, 255]);
    const response = await exchange(s, longFrame(0x53, target, 0x51, payload), r => r[0] === 0x68, timeout);
    return parseMem(response, addr, len);
}

function parseMem(f, addr, len) {
    if (!verify(f) || f[6] !== 0x72) throw new Error('invalid SHARKY response');
    const end = f.length - 2;
    for (let i = 19; i + 5 <= end; i++) {
        if (f[i] !== 0x0F || f[i + 1] !== 0x04) continue;
        const n = f[i + 2], a = f[i + 3] | (f[i + 4] << 8), start = i + 5;
        if (a !== addr) continue;
        if (n < len || start + n > end) throw new Error('truncated SHARKY response');
        return f.slice(start, start + len);
    }
    throw new Error('RAM address ' + addr + ' not found in SHARKY response');
}

function longFrame(c, a, ci, data) {
    const l = data.length + 3, f = Buffer.alloc(l + 6);
    f[0] = 0x68; f[1] = l; f[2] = l; f[3] = 0x68; f[4] = c; f[5] = a; f[6] = ci; data.copy(f, 7);
    f[f.length - 2] = sum(f.slice(4, -2)); f[f.length - 1] = 0x16;
    return f;
}

function sum(b) { let n = 0; for (const x of b) n = (n + x) & 255; return n; }
function verify(f) {
    if (f.length === 1) return f[0] === 0xE5;
    if (f[0] === 0x10) return f.length === 5 && f[4] === 0x16 && sum(f.slice(1, 3)) === f[3];
    return f[0] === 0x68 && f.length >= 9 && f[1] === f[2] && f[3] === 0x68 && f.length === f[1] + 6 && f[f.length - 1] === 0x16 && sum(f.slice(4, -2)) === f[f.length - 2];
}

function exchange(s, request, match, timeout) {
    return new Promise((resolve, reject) => {
        let buf = Buffer.alloc(0), done = false;
        const cleanup = () => { clearTimeout(timer); s.off('data', data); s.off('error', fail); s.off('close', closed); };
        const finish = (e, f) => { if (done) return; done = true; cleanup(); e ? reject(e) : resolve(f); };
        const fail = e => finish(e), closed = () => finish(new Error('TCP connection closed'));
        const data = chunk => {
            buf = Buffer.concat([buf, chunk]);
            while (true) {
                const x = takeFrame(buf); if (!x) return; buf = x.rest;
                if (verify(x.frame) && match(x.frame)) return finish(null, x.frame);
            }
        };
        const timer = setTimeout(() => finish(new Error('M-Bus response timeout')), timeout);
        s.on('data', data); s.once('error', fail); s.once('close', closed); s.write(request, e => e && finish(e));
    });
}

function takeFrame(buf) {
    let i = 0; while (i < buf.length && ![0xE5, 0x68, 0x10].includes(buf[i])) i++;
    if (i === buf.length) return null; if (i) buf = buf.slice(i);
    if (buf[0] === 0xE5) return {frame: buf.slice(0, 1), rest: buf.slice(1)};
    if (buf[0] === 0x10) return buf.length < 5 ? null : {frame: buf.slice(0, 5), rest: buf.slice(5)};
    if (buf.length < 4) return null;
    if (buf[1] !== buf[2] || buf[3] !== 0x68) return {frame: Buffer.alloc(0), rest: buf.slice(1)};
    const n = buf[1] + 6; return buf.length < n ? null : {frame: buf.slice(0, n), rest: buf.slice(n)};
}

function isEnabled(a, id) {
    return new Promise(resolve => a.getState(id, (e, s) => resolve(!e && s ? s.val !== false : true)));
}
function getState(a, id) { return new Promise(resolve => a.getState(id, (e, s) => resolve(e ? null : s))); }
function setState(a, id, val, ack) { return new Promise((resolve, reject) => a.setState(id, {val, ack}, e => e ? reject(e) : resolve())); }
function object(a, id, o) { return new Promise((resolve, reject) => a.setObjectNotExists(id, o, e => e ? reject(e) : resolve())); }

async function ensureStates(a, ns, sc) {
    const base = ns + '.data.';
    await object(a, base + p.output.state, {type:'state', common:{name:'Energy high resolution',role:'value.power.consumption',type:'number',read:true,write:false,unit:'Wh'}, native:{deviceProfile:p.id,source:'ZVENAKK',zceinh:sc.zceinh,kommae:sc.kommae,enakcm:sc.enakcm}});
    const id = base + p.output.enabledState;
    await object(a, id, {type:'state',common:{name:'Enable SHARKY 775 high-resolution readout',role:'switch.enable',type:'boolean',read:true,write:true,def:true},native:{deviceProfile:p.id}});
    if (!(await getState(a, id))) await setState(a, id, true, true);
}

function logError(a, id, e) {
    const n = (errors.get(id) || 0) + 1; errors.set(id, n);
    const msg = 'Optional SHARKY 775 high-resolution read failed for M-Bus ID ' + id + ': ' + e.message;
    if (!a.log) return;
    if (n === 1) a.log.info(msg + ' (standard M-Bus values are unaffected)');
    else a.log.debug(msg);
}

module.exports = {install};
