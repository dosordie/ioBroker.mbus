'use strict';

// Some meters can change the composition/order of their returned records after
// reconfiguration (e.g. Hager ECM parameter sets). The upstream adapter uses
// numbered state IDs derived from the record index and setObjectNotExists(), so
// an existing object may keep an old common.type even when that index now
// contains another record type. ioBroker then rejects the new value.
//
// Keep the upstream naming scheme, but repair the object definition on first
// initialization when the incoming type no longer matches the existing one.

let installed = false;

function isNumberedDataState(id) {
    return typeof id === 'string' && /\.data\.\d+(?:-\d+)?(?:-Current|-Max|-Min|-Error)?$/.test(id);
}

function install() {
    if (installed) return;
    installed = true;

    const utils = require('@iobroker/adapter-core');
    const oldSetObjectNotExists = utils.Adapter.prototype.setObjectNotExists;

    utils.Adapter.prototype.setObjectNotExists = function (id, obj, cb) {
        if (!isNumberedDataState(id) || !obj || obj.type !== 'state' || !obj.common) {
            return oldSetObjectNotExists.call(this, id, obj, cb);
        }

        const adapter = this;
        return adapter.getObject(id, (err, existing) => {
            if (err || !existing || !existing.common || existing.common.type === obj.common.type) {
                return oldSetObjectNotExists.call(adapter, id, obj, cb);
            }

            if (adapter.log) {
                adapter.log.info('Adjust M-Bus state object type for ' + adapter.namespace + '.' + id +
                    ' from ' + existing.common.type + ' to ' + obj.common.type + ' because the meter record layout changed');
            }

            return adapter.extendObject(id, {
                common: {
                    name: obj.common.name,
                    role: obj.common.role,
                    type: obj.common.type,
                    read: obj.common.read,
                    write: obj.common.write,
                    unit: obj.common.unit
                },
                native: obj.native || {}
            }, cb);
        });
    };
}

module.exports = {install};
