'use strict';

// Applies the optional per-device configured name only to common.name of the
// ioBroker device channel. The technical object ID / namespace remains e.g.
// DME-61580093 or HAG-99981916 and is never renamed.

let installed = false;
let adapter;
const appliedNames = new Map();

function configuredName(deviceId, fallback) {
    const configuredDevices = adapter && adapter.config && Array.isArray(adapter.config.devices)
        ? adapter.config.devices
        : [];
    const cfg = configuredDevices.find(device => String(device.id) === String(deviceId));
    const name = cfg && cfg.name !== undefined && cfg.name !== null ? String(cfg.name).trim() : '';
    return name || fallback;
}

function applyDisplayName(deviceId, data, callback) {
    if (!adapter || !data || !data.SlaveInformation) {
        if (callback) callback();
        return;
    }

    const info = data.SlaveInformation;
    if (!info.Manufacturer || info.Id === undefined || info.Id === null) {
        if (callback) callback();
        return;
    }

    const namespace = info.Manufacturer + '-' + info.Id;
    const name = configuredName(deviceId, namespace);

    if (appliedNames.get(namespace) === name) {
        if (callback) callback();
        return;
    }

    adapter.extendObject(namespace, {
        common: {
            name
        }
    }, err => {
        if (err) {
            if (adapter.log) adapter.log.debug('Could not set display name for ' + namespace + ': ' + err);
        } else {
            appliedNames.set(namespace, name);
            if (adapter.log) {
                adapter.log.debug('M-Bus ' + namespace + ' display name: ' + name);
            }
        }
        if (callback) callback();
    });
}

function install() {
    if (installed) return;
    installed = true;

    const utils = require('@iobroker/adapter-core');
    const MbusMaster = require('node-mbus');

    const oldOn = utils.Adapter.prototype.on;
    utils.Adapter.prototype.on = function (name, fn) {
        if (!adapter && (this.name === 'mbus' || String(this.namespace || '').startsWith('mbus.'))) {
            adapter = this;
        }
        return oldOn.call(this, name, fn);
    };

    const oldGetData = MbusMaster.prototype.getData;
    MbusMaster.prototype.getData = function (id, cb) {
        return oldGetData.call(this, id, (err, data) => {
            this.__deviceDisplayNamePending = !err && data ? {
                id: String(id),
                data
            } : null;
            cb(err, data);
        });
    };

    // Installed as the outermost close wrapper. At this point the regular
    // device channel has already been created by main.js and all optional
    // SHARKY work has completed, so common.name can safely be updated.
    const oldClose = MbusMaster.prototype.close;
    MbusMaster.prototype.close = function (cb) {
        const master = this;
        const pending = master.__deviceDisplayNamePending;
        master.__deviceDisplayNamePending = null;

        return oldClose.call(master, err => {
            if (err || !pending) {
                if (cb) cb(err);
                return;
            }

            applyDisplayName(pending.id, pending.data, () => {
                if (cb) cb(err);
            });
        });
    };
}

module.exports = {
    install
};
