'use strict';

require('./lib/sharky775-highres').install();
require('./lib/hager-ecm').install();

const startAdapter = require('./main');

if (module && module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}
