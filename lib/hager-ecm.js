'use strict';

// Hager ECM140D / ECM180D use the Herholdt M1PRO/M3PRO M-Bus data layout.
// node-mbus currently exposes the manufacturer-specific VIFEs for power factor
// and net frequency only as "Manufacturer specific". Decode those values from
// the six-byte Parameter Set Identification without changing node-mbus itself.

let installed = false;

function parameterSetBytes(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) return null;
    let n = BigInt(value);
    const mod = 1n << 48n;
    if (n < 0) n += mod; // node-mbus exposes INT6 as signed for values with bit 47 set
    if (n < 0 || n >= mod) return null;

    const bytes = [];
    for (let i = 0; i < 6; i++) {
        bytes.push(Number((n >> BigInt(i * 8)) & 0xFFn));
    }
    return bytes;
}

function hexParameterSet(bytes) {
    return bytes.map(v => v.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function decode(data) {
    const info = data && data.SlaveInformation;
    const records = data && Array.isArray(data.DataRecord) ? data.DataRecord : null;
    if (!info || !records || String(info.Manufacturer || '').toUpperCase() !== 'HAG') return null;

    const modelRecord = records.find(r => r && r.Unit === 'Model / Version');
    const model = modelRecord ? String(modelRecord.Value || '').trim().toUpperCase() : '';
    if (model !== 'ECM140D' && model !== 'ECM180D') return null;

    const parameterRecord = records.find(r => r && r.Unit === 'Parameter set identification');
    const bytes = parameterRecord ? parameterSetBytes(parameterRecord.Value) : null;
    if (!bytes) return null;

    const s4 = bytes[4];
    const s5 = bytes[5];
    const manufacturerSpecific = records.filter(r => r && r.Unit === 'Manufacturer specific' && typeof r.Value === 'number');

    // Herholdt transmits these manufacturer-specific values in this order on
    // the single-phase family: current tariff, power factor(s), net frequency.
    // Consuming the tariff first is important: the default ECM140D parameter
    // set contains tariff=1/2 but no power factor or frequency.
    const expected = [];
    if (s4 & 0x80) expected.push({kind: 'tariff'});
    if (s5 & 0x10) expected.push({kind: 'power_factor_l1', name: 'Power factor L1'});
    if (s5 & 0x20) expected.push({kind: 'power_factor_l2', name: 'Power factor L2'});
    if (s5 & 0x40) expected.push({kind: 'power_factor_l3', name: 'Power factor L3'});
    if (s5 & 0x80) expected.push({kind: 'power_factor', name: 'Power factor'});
    if (s4 & 0x40) expected.push({kind: 'frequency', name: 'Frequency'});

    const values = [];
    for (let i = 0; i < expected.length && i < manufacturerSpecific.length; i++) {
        const field = expected[i];
        const record = manufacturerSpecific[i];
        if (field.kind === 'tariff') continue;

        if (field.kind.startsWith('power_factor')) {
            values.push({
                id: field.kind,
                name: field.name,
                unit: '',
                value: Number(record.Value) * 0.01,
                raw: record.Value,
                rawRecordId: record.id,
                timestamp: record.Timestamp
            });
        } else if (field.kind === 'frequency') {
            values.push({
                id: 'frequency',
                name: 'Frequency',
                unit: 'Hz',
                value: Number(record.Value) * 0.1,
                raw: record.Value,
                rawRecordId: record.id,
                timestamp: record.Timestamp
            });
        }
    }

    return {
        model,
        parameterSet: hexParameterSet(bytes),
        values
    };
}

function augment(data) {
    const decoded = decode(data);
    if (!decoded || !decoded.values.length) return decoded;

    // Append decoded virtual records. Keeping the raw manufacturer-specific
    // records is intentional for diagnostics; the new records get stable,
    // readable ioBroker IDs such as data.power_factor and data.frequency.
    for (const item of decoded.values) {
        data.DataRecord.push({
            id: item.id,
            Function: 'Manufacturer specific',
            Unit: item.unit,
            Value: item.value,
            Timestamp: item.timestamp,
            HagerDecodedName: item.name,
            HagerRawRecordId: item.rawRecordId,
            HagerRawValue: item.raw,
            HagerParameterSet: decoded.parameterSet
        });
    }
    return decoded;
}

function install() {
    if (installed) return;
    installed = true;
    const MbusMaster = require('node-mbus');
    const oldGetData = MbusMaster.prototype.getData;

    MbusMaster.prototype.getData = function (id, cb) {
        return oldGetData.call(this, id, (err, data) => {
            if (!err && data) augment(data);
            cb(err, data);
        });
    };
}

module.exports = {install, decode, augment, parameterSetBytes};
