'use strict';

// Runtime-selectable polling interval per M-Bus device.
//
// Poll_intervall_inividuell = false -> adapter defaultUpdateInterval
// Poll_intervall_inividuell = true  -> configured interval of this device
//
// The upstream recurring device timer is disabled. This module owns exactly one
// one-shot timer per device. A timer only requests the next poll; it does NOT
// re-arm itself. The next timer starts only after MbusMaster.close() has fully
// completed. Because this module is installed after sharky775-highres, that
// means a SHARKY cycle includes normal M-Bus read + optional high-resolution
// RAM read + application reset before the next interval starts.
//
// On a real true -> false transition, one final poll is deliberately performed
// after the configured fast/individual interval. Only after that final cycle
// has completed does the standard/slow interval start. This captures fresh end
// values shortly after a pump/device switches off without re-filling the queue.

const CONTROL_STATE = 'Poll_intervall_inividuell';
const DEFAULT_VERSION = 2;

let installed = false;
let adapter;
let prepared = false;
const devices = new Map();
const namespaceToDevice = new Map();
const timers = new Map();
const subscribed = new Set();
const cyclesInProgress = new Set();

function normalizeDefaultInterval(value) {
    if (value && value !== '0' && value !== 0) {
        return parseInt(value, 10) || 3600;
    }
    return 0;
}

function normalizeDeviceInterval(value, fallback) {
    if (value === '' || value === undefined || value === null) return fallback;
    if (value && value !== '0' && value !== 0) return parseInt(value, 10) || fallback;
    return 0;
}

function prepare(a) {
    if (prepared) return;
    prepared = true;
    adapter = a;

    const standardInterval = normalizeDefaultInterval(a.config && a.config.defaultUpdateInterval);
    const configuredDevices = a.config && Array.isArray(a.config.devices) ? a.config.devices : [];

    for (const cfg of configuredDevices) {
        const id = String(cfg.id);
        const individualInterval = normalizeDeviceInterval(cfg.updateInterval, standardInterval);
        devices.set(id, {
            id,
            namespace: null,
            standardInterval,
            individualInterval,
            individualEnabled: true,
            finalFastPollPending: false,
            finalFastPollQueued: false,
            finalFastPollInProgress: false
        });

        // main.js must not create a second recurring timer. It still performs
        // the normal initialization read for every configured device.
        cfg.updateInterval = 0;
    }

    if (a.log) {
        a.log.info('Runtime poll interval switch enabled: default=individual; standard=' + standardInterval + 's; ' +
            devices.size + ' device(s). Poll interval starts after each complete device cycle.');
        for (const device of devices.values()) {
            a.log.info('Runtime poll M-Bus-ID ' + device.id + ': individual=' + device.individualInterval +
                's, standard=' + device.standardInterval + 's, initial mode=individual; final fast poll on switch to standard');
        }
    }
}

function clearTimer(deviceId) {
    const timer = timers.get(String(deviceId));
    if (timer) clearTimeout(timer);
    timers.delete(String(deviceId));
}

function clearAllTimers() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    cyclesInProgress.clear();
}

function effectiveInterval(device) {
    return device.individualEnabled ? device.individualInterval : device.standardInterval;
}

function pulseUpdateNow(device) {
    if (!adapter || !device || !device.namespace) return;

    const id = device.namespace + '.updateNow';
    adapter.setState(id, {val: true, ack: false}, err => {
        if (err && adapter.log) adapter.log.debug('Could not trigger ' + id + ': ' + err);
        setTimeout(() => {
            if (!adapter) return;
            adapter.setState(id, {val: false, ack: true}, () => {});
        }, 100);
    });
}

function scheduleNext(deviceId) {
    const device = devices.get(String(deviceId));
    if (!device || !device.namespace) return;

    clearTimer(device.id);

    // If the final fast transition poll is already queued, do not schedule
    // anything else until that request is actually processed.
    if (device.finalFastPollQueued) {
        if (adapter && adapter.log) {
            adapter.log.debug('M-Bus ' + device.namespace + ' waits for queued final fast poll before standard polling starts');
        }
        return;
    }

    // If the device is currently being processed, close() will schedule the
    // timer after the complete cycle. This avoids a timer expiring while a
    // SHARKY high-resolution read/reset is still running.
    if (cyclesInProgress.has(device.id)) {
        if (adapter && adapter.log) {
            adapter.log.debug('M-Bus ' + device.namespace + ' poll timer waits for current device cycle to finish');
        }
        return;
    }

    const finalFast = !device.individualEnabled && device.finalFastPollPending;
    const interval = finalFast ? device.individualInterval : effectiveInterval(device);
    const mode = finalFast ? 'final fast poll before standard' : (device.individualEnabled ? 'individual' : 'standard');

    if (adapter && adapter.log) {
        adapter.log.debug('M-Bus ' + device.namespace + ' next poll in ' + interval + 's (' +
            mode + ', after completed cycle)');
    }

    if (interval <= 0) {
        // A configured fast interval of 0 cannot provide a delayed transition
        // poll. Fall through to standard mode rather than getting stuck.
        if (finalFast) {
            device.finalFastPollPending = false;
            scheduleNext(device.id);
        }
        return;
    }

    timers.set(device.id, setTimeout(() => {
        // One shot only. Do not re-arm here. A successful/failed device cycle
        // will re-arm after close() has completely finished.
        timers.delete(device.id);

        if (finalFast && !device.individualEnabled && device.finalFastPollPending) {
            device.finalFastPollQueued = true;
            if (adapter && adapter.log) {
                adapter.log.debug('M-Bus ' + device.namespace + ' final fast poll queued; standard interval starts after it completes');
            }
        }

        pulseUpdateNow(device);
    }, interval * 1000));
}

function object(a, id, obj) {
    return new Promise((resolve, reject) => {
        a.setObjectNotExists(id, obj, err => err ? reject(err) : resolve());
    });
}

function extendObject(a, id, obj) {
    return new Promise((resolve, reject) => {
        a.extendObject(id, obj, err => err ? reject(err) : resolve());
    });
}

function getObject(a, id) {
    return new Promise(resolve => a.getObject(id, (err, obj) => resolve(err ? null : obj)));
}

function getState(a, id) {
    return new Promise(resolve => a.getState(id, (err, state) => resolve(err ? null : state)));
}

function setState(a, id, val, ack) {
    return new Promise((resolve, reject) => {
        a.setState(id, {val, ack}, err => err ? reject(err) : resolve());
    });
}

async function ensureControlState(device) {
    if (!adapter || !device || !device.namespace) return true;

    const id = device.namespace + '.' + CONTROL_STATE;
    const existingObject = await getObject(adapter, id);
    const migrateToTrue = !existingObject || !existingObject.native || existingObject.native.pollDefaultVersion !== DEFAULT_VERSION;

    await object(adapter, id, {
        type: 'state',
        common: {
            name: 'Poll-Intervall individuell',
            role: 'switch.enable',
            type: 'boolean',
            read: true,
            write: true,
            def: true
        },
        native: {
            standardInterval: device.standardInterval,
            individualInterval: device.individualInterval,
            pollDefaultVersion: DEFAULT_VERSION,
            description: 'false = adapter defaultUpdateInterval, true = configured device updateInterval'
        }
    });

    // 2.7.5 originally created this state with default=false. Migrate that old
    // object once to the requested default=true. The marker prevents later
    // restarts from overwriting a deliberate user choice.
    if (existingObject && migrateToTrue) {
        await extendObject(adapter, id, {
            common: {def: true},
            native: {
                standardInterval: device.standardInterval,
                individualInterval: device.individualInterval,
                pollDefaultVersion: DEFAULT_VERSION,
                description: 'false = adapter defaultUpdateInterval, true = configured device updateInterval'
            }
        });
    }

    if (!subscribed.has(id)) {
        adapter.subscribeStates(id);
        subscribed.add(id);
    }

    const state = await getState(adapter, id);
    if (!state || migrateToTrue) {
        device.individualEnabled = true;
        await setState(adapter, id, true, true);
    } else {
        device.individualEnabled = state.val === true;
    }

    return device.individualEnabled;
}

function mapDevice(deviceId, data) {
    const device = devices.get(String(deviceId));
    const info = data && data.SlaveInformation;
    if (!device || !info || !info.Manufacturer || info.Id === undefined) return device || null;

    const namespace = info.Manufacturer + '-' + info.Id;
    device.namespace = namespace;
    namespaceToDevice.set(namespace, device.id);
    return device;
}

function finishCycle(deviceId, data) {
    const id = String(deviceId);
    const device = mapDevice(id, data) || devices.get(id);
    cyclesInProgress.delete(id);
    if (!device || !device.namespace || !adapter) return;

    if (device.finalFastPollInProgress) {
        device.finalFastPollInProgress = false;
        device.finalFastPollPending = false;
        if (adapter && adapter.log) {
            adapter.log.debug('M-Bus ' + device.namespace + ' final fast poll completed; switching fully to standard ' +
                device.standardInterval + 's');
        }
    }

    ensureControlState(device)
        .then(() => scheduleNext(device.id))
        .catch(err => {
            if (adapter && adapter.log) adapter.log.debug('Poll interval state setup failed for ' + device.id + ': ' + err.message);
            scheduleNext(device.id);
        });
}

function handleStateChange(a, id, state) {
    if (!state || state.ack || !id) return;

    const suffix = '.' + CONTROL_STATE;
    if (!id.endsWith(suffix)) return;

    let relativeId = id;
    if (a.namespace && relativeId.startsWith(a.namespace + '.')) {
        relativeId = relativeId.slice(a.namespace.length + 1);
    }

    const namespace = relativeId.slice(0, -suffix.length);
    const deviceId = namespaceToDevice.get(namespace);
    const device = deviceId ? devices.get(deviceId) : null;
    if (!device) return;

    const wasIndividual = device.individualEnabled;
    const newIndividual = state.val === true;

    // Node-RED may write the same boolean repeatedly while the source value
    // changes within the same range (e.g. 20% -> 30% is true -> true). A repeated
    // value must not restart the active poll timer or create another final poll.
    if (newIndividual === wasIndividual) {
        a.setState(namespace + '.' + CONTROL_STATE, {val: wasIndividual, ack: true}, () => {});
        if (a.log) {
            a.log.debug('M-Bus ' + namespace + ' polling mode unchanged (' +
                (wasIndividual ? 'individual' : 'standard') + '); timer left untouched');
        }
        return;
    }

    device.individualEnabled = newIndividual;

    if (newIndividual) {
        // Returning to fast mode cancels a not-yet-processed transition poll.
        // A request that is already in the adapter's own queue cannot be removed,
        // but it simply becomes a normal fast poll when processed.
        device.finalFastPollPending = false;
        device.finalFastPollQueued = false;
        device.finalFastPollInProgress = false;
    } else {
        // Only the real true -> false edge creates one final fast poll.
        device.finalFastPollPending = true;
        device.finalFastPollQueued = false;
        device.finalFastPollInProgress = false;
    }

    a.setState(namespace + '.' + CONTROL_STATE, {val: device.individualEnabled, ack: true}, () => {});

    if (a.log) {
        if (!newIndividual) {
            a.log.info('M-Bus ' + namespace + ' polling switched to standard ' + device.standardInterval +
                's; one final poll will run after fast interval ' + device.individualInterval + 's');
        } else {
            a.log.info('M-Bus ' + namespace + ' polling switched to individual ' + device.individualInterval + 's');
        }
    }

    // Apply the requested mode immediately. On true -> false, scheduleNext()
    // deliberately selects the individual interval once more. If a device cycle
    // is running, its close() completion schedules that final delayed poll.
    scheduleNext(device.id);
}

function install() {
    if (installed) return;
    installed = true;

    const utils = require('@iobroker/adapter-core');
    const MbusMaster = require('node-mbus');

    const oldOn = utils.Adapter.prototype.on;
    utils.Adapter.prototype.on = function (name, fn) {
        if (!adapter && (this.name === 'mbus' || String(this.namespace || '').startsWith('mbus.'))) adapter = this;

        if (name === 'ready') {
            const a = this;
            return oldOn.call(this, name, function () {
                prepare(a);
                return fn.apply(this, arguments);
            });
        }

        if (name === 'stateChange') {
            const a = this;
            return oldOn.call(this, name, function (id, state) {
                handleStateChange(a, id, state);
                return fn.apply(this, arguments);
            });
        }

        if (name === 'unload') {
            return oldOn.call(this, name, function () {
                clearAllTimers();
                return fn.apply(this, arguments);
            });
        }

        return oldOn.call(this, name, fn);
    };

    // Remember which device is being processed, but do not start its next timer
    // at getData() completion. SHARKY still has proprietary work to do in close().
    const oldGetData = MbusMaster.prototype.getData;
    MbusMaster.prototype.getData = function (id, cb) {
        const deviceId = String(id);
        const device = devices.get(deviceId);

        clearTimer(deviceId);
        cyclesInProgress.add(deviceId);

        if (device && device.finalFastPollQueued) {
            device.finalFastPollQueued = false;
            device.finalFastPollInProgress = true;
            if (adapter && adapter.log && device.namespace) {
                adapter.log.debug('M-Bus ' + device.namespace + ' processing final fast poll before standard mode');
            }
        }

        return oldGetData.call(this, id, (err, data) => {
            mapDevice(deviceId, data);
            this.__individualPollPending = {
                id: deviceId,
                data: data || null
            };
            cb(err, data);
        });
    };

    // IMPORTANT: individual-poll must be installed AFTER sharky775-highres.
    // oldClose then points at the SHARKY close wrapper. Its callback is invoked
    // only after normal close + optional high-resolution read + application reset.
    const oldClose = MbusMaster.prototype.close;
    MbusMaster.prototype.close = function (cb) {
        const master = this;
        return oldClose.call(master, err => {
            const pending = master.__individualPollPending;
            master.__individualPollPending = null;

            if (pending) finishCycle(pending.id, pending.data);
            if (cb) cb(err);
        });
    };
}

module.exports = {
    install,
    CONTROL_STATE,
    normalizeDefaultInterval,
    normalizeDeviceInterval
};
