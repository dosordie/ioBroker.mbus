'use strict';

require('./lib/object-type-sync').install();
require('./lib/sharky775-highres').install();
require('./lib/individual-poll').install();
require('./lib/hager-ecm').install();
require('./lib/device-display-name').install();

const startAdapter = require('./main');

if (module && module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
