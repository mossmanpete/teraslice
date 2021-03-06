'use strict';

const { ConvictSchema } = require('@terascope/job-components');

class Schema extends ConvictSchema {
    build() {
        return {
            limit: {
                doc: 'Specify a number > 0 to limit the number of results printed to the console log.'
                    + 'This prints results from the beginning of the result set.',
                default: 0,
                format(val) {
                    if (isNaN(val)) {
                        throw new Error('stdout limit must be a number.');
                    } else if (val < 0) {
                        throw new Error('stdout limit must be a number greater than 0.');
                    }
                }
            }
        };
    }
}

module.exports = Schema;
