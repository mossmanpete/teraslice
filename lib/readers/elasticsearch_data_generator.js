'use strict';

var jsf = require('json-schema-faker');
var fs = require('fs');
var dataSchema = require('./data_utils');


function newReader(context, opConfig, jobConfig) {
    var context = context;
    var opConfig = opConfig;
    var schema = getSchema(opConfig);

    return function(msg) {
        var results = [];

        for (var i = 0; i < msg; i++) {
            results.push(jsf(schema))
        }

        return results;
    }
}

function getSchema(config) {

    if (config.json_schema) {
        var firstPath = config.json_schema;
        var nextPath = process.cwd() + '/' + config.json_schema;

        try {
            if (fs.existsSync(firstPath)) {
                return require(firstPath);
            }
            else {
                return require(nextPath);
            }
        }
        catch (e) {
            throw new Error('Could not retrieve code for: ' + opConfig + '\n' + e);
        }
    }
    else {
        return dataSchema;
    }
}
function onceGenerator(context, opConfig, jobConfig) {
    var opConfig = opConfig;
    var numOfRecords = opConfig.size;
    var lastOp = jobConfig.operations[jobConfig.operations.length - 1];
    var interval = lastOp.size ? lastOp.size : 5000;

    return function() {
        if (numOfRecords <= 0) {
            return null;
        }
        else {
            if (numOfRecords - interval >= 0) {
                numOfRecords = numOfRecords - interval;
                return interval;
            }
            else {
                var finalCount = numOfRecords;
                numOfRecords = 0;
                return finalCount;
            }
        }
    }
}

function persistentGenerator(context, opConfig, jobConfig) {
    var numOfRecords = opConfig.size;

    return function() {
        return numOfRecords;
    }
}

function newSlicer(context, opConfig, jobConfig) {

    if (jobConfig.lifecycle === 'once') {
        return onceGenerator(context, opConfig, jobConfig)
    }

    else if (jobConfig.lifecycle === 'persistent') {
        return persistentGenerator(context, opConfig, jobConfig)
    }

    else {
        throw new Error('Please verify lifecycle setting in the job config to either "once" or "persistent" ')
    }
}

function schema() {
    return {
        /*index: {
         doc: 'Which index to read from',
         default: '',
         format: 'required_String'

         },
         size: {
         doc: 'The limit to the number of docs pulled in a chunk, if the number of docs retrieved ' +
         'by the interval exceeds this number, it will cause the function to recurse to provide a smaller batch',
         default: 5000,
         format: Number
         },
         start: {
         doc: 'The start date (ISOstring or in ms) to which it will read from ',
         default: ''
         },
         end: {
         doc: 'The end date (ISOstring or in ms) to which it will read to',
         default: ''

         },
         interval: {
         doc: 'The time interval in which it will read from, the number must be separated from the unit of time ' +
         'by an underscore. The unit of time may be months, weeks, days, hours, minutes, seconds, millesconds ' +
         'or their appropriate abbreviations',
         default: '5_mins',
         format: String
         },
         date_field_name: {
         doc: 'field name where the date of the doc is located',
         default: '',
         format: 'required_String'
         }*/
    };
}

module.exports = {
    newReader: newReader,
    newSlicer: newSlicer,
    schema: schema
};

