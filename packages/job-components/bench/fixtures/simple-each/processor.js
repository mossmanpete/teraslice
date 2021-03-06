'use strict';

const { EachProcessor } = require('../../../dist');

class SimpleEach extends EachProcessor {
    constructor(...args) {
        super(...args);
        this.counter = 0;
    }

    forEach(data) {
        if (!data) return;
        this.counter++;
    }
}

module.exports = SimpleEach;
