'use strict';

const _ = require('lodash');
const PQueue = require('p-queue');
const pWhilst = require('p-whilst');
const Promise = require('bluebird');
const retry = require('bluebird-retry');
const parseError = require('@terascope/error-parser');
const Messaging = require('@terascope/teraslice-messaging');

const Scheduler = require('./scheduler');
const ExecutionAnalytics = require('./analytics');
const makeExecutionRecovery = require('./recovery');
const makeSliceAnalytics = require('./slice-analytics');
const { waitForWorkerShutdown } = require('../helpers/worker-shutdown');
const { makeStateStore, makeExStore } = require('../../cluster/storage');
const { makeLogger, generateWorkerId } = require('../helpers/terafoundation');

const ExecutionControllerServer = Messaging.ExecutionController.Server;
const ClusterMasterClient = Messaging.ClusterMaster.Client;
const { formatURL } = Messaging;

// const immediate = Promise.promisify(setImmediate);

class ExecutionController {
    constructor(context, executionContext) {
        const workerId = generateWorkerId(context);
        const logger = makeLogger(context, executionContext, 'execution_controller');
        const events = context.apis.foundation.getSystemEvents();
        const slicerPort = executionContext.slicer_port;
        const networkLatencyBuffer = _.get(context, 'sysconfig.teraslice.network_latency_buffer');
        const actionTimeout = _.get(context, 'sysconfig.teraslice.action_timeout');
        const workerDisconnectTimeout = _.get(context, 'sysconfig.teraslice.worker_disconnect_timeout');
        const nodeDisconnectTimeout = _.get(context, 'sysconfig.teraslice.node_disconnect_timeout');
        const shutdownTimeout = _.get(context, 'sysconfig.teraslice.shutdown_timeout');
        const recoverExecution = _.get(executionContext.config, 'recovered_execution', false);

        this.server = new ExecutionControllerServer({
            port: slicerPort,
            networkLatencyBuffer,
            actionTimeout,
            workerDisconnectTimeout,
        });

        const clusterMasterPort = _.get(context, 'sysconfig.teraslice.port');
        const clusterMasterHostname = _.get(context, 'sysconfig.teraslice.master_hostname');

        this.client = new ClusterMasterClient({
            clusterMasterUrl: formatURL(clusterMasterHostname, clusterMasterPort),
            executionContext,
            networkLatencyBuffer,
            actionTimeout,
            connectTimeout: nodeDisconnectTimeout,
            exId: executionContext.ex_id,
        });

        this.executionAnalytics = new ExecutionAnalytics(
            context,
            executionContext,
            this.client
        );

        this.scheduler = new Scheduler(context, executionContext);

        this.dispatchQueue = new PQueue({
            carryoverConcurrencyCount: true,
            concurrency: executionContext.config.workers,
            intervalCap: 1,
            interval: 100,
            autoStart: false,
        });

        this.exId = _.get(executionContext, 'config.ex_id');
        this.workerId = workerId;
        this.logger = logger;
        this.events = events;
        this.context = context;
        this.executionContext = executionContext;
        this.collectAnalytics = this.executionContext.config.analytics;
        this.shutdownTimeout = shutdownTimeout;
        this.workerDisconnectTimeout = workerDisconnectTimeout;
        this.recoverExecution = recoverExecution;
        this.recoveryComplete = !recoverExecution;
        this.stores = {};

        this.isPaused = false;
        this.isShutdown = false;
        this.isShuttingDown = false;
        this.isInitialized = false;
        this.isStarted = false;
        this.pendingSlices = 0;
        this.isDoneProcessing = false;
        this.isExecutionFinished = false;
        this.isExecutionDone = false;
        this.workersHaveConnected = false;
        this._handlers = {};

        this.setFailingStatus = this.setFailingStatus.bind(this);
        this.terminalError = this.terminalError.bind(this);
    }

    async initialize() {
        const { context } = this;

        const exStore = makeExStore(context);
        this.stores.exStore = await exStore;

        await this.client.start();

        let verified;
        let verifiedErr;
        try {
            verified = await this._verifyExecution();
        } catch (err) {
            verifiedErr = err;
        }
        if (!verified) {
            this.isShutdown = true;
            await this.stores.exStore.shutdown(true);
            await this.client.shutdown();
            if (verifiedErr) {
                throw verifiedErr;
            }
            return;
        }

        const stateStore = makeStateStore(context);
        this.stores.stateStore = await stateStore;

        await this.server.start();

        this.isInitialized = true;

        this.server.onClientOnline((workerId) => {
            this.logger.trace(`worker ${workerId} is online`);
            this._adjustSlicerQueueLength();
            this.workersHaveConnected = true;
            clearTimeout(this.workerConnectTimeoutId);
            this.executionAnalytics.increment('workers_joined');
        });

        this.server.onClientAvailable((workerId) => {
            this.logger.trace(`worker ${workerId} is available`);
            this.executionAnalytics.set('workers_available', this.server.availableClientCount);
            this.executionAnalytics.set('workers_active', this.server.activeWorkers.length);
        });

        this.server.onClientUnavailable(() => {
            this.executionAnalytics.set('workers_active', this.server.activeWorkers.length);
            this.executionAnalytics.set('workers_available', this.server.availableClientCount);
        });

        this.server.onClientDisconnect((workerId) => {
            this.logger.trace(`worker ${workerId} is disconnected but it may reconnect`);
            this.executionAnalytics.increment('workers_disconnected');
            this.executionAnalytics.set('workers_active', this.server.activeWorkers.length);

            this._startWorkerDisconnectWatchDog();
        });

        this.server.onClientOffline((workerId) => {
            this.logger.trace(`worker ${workerId} is offline`);
            this._adjustSlicerQueueLength();
        });

        this.server.onClientReconnect((workerId) => {
            clearTimeout(this.workerDisconnectTimeoutId);
            this.logger.trace(`worker ${workerId} is reconnected`);

            this.executionAnalytics.increment('workers_reconnected');
        });

        this.client.onExecutionPause(() => this.pause());
        this.client.onExecutionResume(() => this.resume());
        this.client.onServerShutdown(() => {
            this.logger.warn('Cluster Master shutdown, exiting...');
            this._endExecution();
        });

        this.server.onSliceSuccess((workerId, response) => {
            this.logger.info(`worker ${workerId} has completed its slice`, response);
            this.events.emit('slice:success', response);
            this.pendingSlices -= 1;
        });

        this.server.onSliceFailure((workerId, response) => {
            this.logger.error(`worker: ${workerId} has failure completing its slice`, response);
            this.events.emit('slice:failure', response);

            if (this.isOnce) {
                this.setFailingStatus();
            } else if (this.recoverExecution && !this.recoveryComplete) {
                this.terminalError(new Error('Slice failed while recovering'));
            } else {
                // in persistent mode we set watchdogs to monitor
                // when failing can be set back to running
                this._checkAndUpdateExecutionState();
            }

            this.pendingSlices -= 1;
        });

        this._handlers['slicer:execution:update'] = ({ update }) => {
            this.logger.trace('slicer sending a execution update', update);

            // this is updating the opConfig for elasticsearch start and/or end dates for ex,
            // this assumes elasticsearch is first
            this.stores.exStore.update(this.exId, { operations: update });
        };

        this._handlers['slicers:finished'] = (err) => {
            if (err) {
                this.logger.error('slicers finished due to failure', err);
                this.terminalError(err);
            }
        };

        _.forEach(this._handlers, (handler, event) => {
            this.events.on(event, handler);
        });

        this.logger.debug(`execution ${this.exId} is initialized`);

        this.isInitialized = true;
    }

    async run() {
        if (this.isShuttingDown) {
            this.logger.error('Cannot run execution while shutting down');
            return;
        }

        if (!this.isInitialized) {
            this.logger.error('Cannot run execution is not initialized');
            return;
        }

        try {
            await this._runExecution();
        } catch (err) {
            this.logger.error('Run execution error', err);
        }

        this.events.emit('worker:shutdown');

        // help the workers go offline
        this.server.isShuttingDown = true;

        await this._finishExecution();

        try {
            await Promise.all([
                this.client.sendExecutionFinished(),
                this._waitForWorkersToExit(),
            ]);
        } catch (err) {
            this.logger.error('Failure sending execution finished', err);
        }

        this.logger.debug(`execution ${this.exId} is done`);
    }

    async resume() {
        if (!this.isPaused) return;

        this.logger.info(`execution ${this.exId} is resuming...`);

        this.isPaused = false;
        this.scheduler.start();

        await Promise.delay(100);
    }

    async pause() {
        if (this.isPaused) return;

        this.logger.info(`execution ${this.exId} is pausing...`);

        this.isPaused = true;
        this.scheduler.pause();

        await Promise.delay(100);
    }

    async setFailingStatus() {
        const { exStore } = this.stores;

        const errMsg = `slicer: ${this.exId} has encountered a processing_error`;
        this.logger.error(errMsg);

        const executionStats = this.executionAnalytics.getAnalytics();
        const errorMeta = await exStore.executionMetaData(executionStats, errMsg);
        await exStore.setStatus(this.exId, 'failing', errorMeta);
    }

    async terminalError(err) {
        if (this.isExecutionDone) return;

        const { exStore } = this.stores;

        this.slicerFailed = true;

        const msg = `slicer for ex ${this.exId} had an error, shutting down execution`;
        this.logger.error(msg, err);

        const errMsg = `${msg}, caused by ${err.stack ? err.stack : _.toString(err)}`;

        const executionStats = this.executionAnalytics.getAnalytics();
        const errorMeta = await exStore.executionMetaData(executionStats, errMsg);

        await exStore.setStatus(this.exId, 'failed', errorMeta);

        this.logger.fatal(`execution ${this.exId} is done because of slice failure`);
        this._endExecution();
    }

    async shutdown(block = true) {
        if (this.isShutdown) return;
        if (!this.isInitialized) return;

        if (this.isShuttingDown && block) {
            this.logger.debug(`execution shutdown was called for ex ${this.exId} but it was already shutting down, will block until done`);
            await waitForWorkerShutdown(this.context, 'worker:shutdown:complete');
            return;
        }

        this.logger.debug(`execution shutdown was called for ex ${this.exId}`);

        const shutdownErrs = [];

        // allow clients to go immediately from disconnect to offline
        this.server.isShuttingDown = true;

        // tell the scheduler to stop producing slices
        this.scheduler.stop();

        // remove any listeners
        _.forEach(this._handlers, (handler, event) => {
            this.events.removeListener(event, handler);
        });

        this.isShuttingDown = true;
        this.isPaused = false;

        clearInterval(this.watcher);
        clearTimeout(this.workerConnectTimeoutId);
        clearTimeout(this.workerDisconnectTimeoutId);

        await this._waitForExecutionFinished();

        this.dispatchQueue.clear();
        this.scheduler.cleanup();

        if (this.recover) {
            try {
                await this.recover.shutdown();
            } catch (err) {
                shutdownErrs.push(err);
            }
        }

        try {
            await this.executionAnalytics.shutdown();
        } catch (err) {
            this.logger.error('execution analytics error');
        }

        try {
            await this.server.shutdown();
        } catch (err) {
            shutdownErrs.push(err);
        }

        try {
            await this.client.shutdown();
        } catch (err) {
            shutdownErrs.push(err);
        }

        try {
            await Promise.map(Object.values(this.stores), store => store.shutdown(true));
        } catch (err) {
            shutdownErrs.push(err);
        }

        this.logger.warn(`execution controller ${this.exId} is shutdown`);
        this.isShutdown = true;

        if (shutdownErrs.length) {
            const errMsg = shutdownErrs.map(e => e.stack).join(', and');
            const shutdownErr = new Error(`Failed to shutdown correctly: ${errMsg}`);
            this.events.emit(this.context, 'worker:shutdown:complete', shutdownErr);
            throw shutdownErr;
        }

        this.events.emit(this.context, 'worker:shutdown:complete');
    }

    // this is used to determine when the slices are done
    get isOnce() {
        const { lifecycle } = this.executionContext.config;
        return (lifecycle === 'once') && this.recoveryComplete;
    }

    async _adjustSlicerQueueLength() {
        const { dynamicQueueLength, queueLength } = this.executionContext;
        if (!dynamicQueueLength) return;

        if (this.server.onlineClientCount > queueLength) {
            this.executionContext.queueLength = this.server.onlineClientCount;
            this.logger.info(`adjusted queue length ${this.executionContext.queueLength}`);
        }
    }

    async _runExecution() {
        this._startWorkConnectWatchDog();

        this.slicerAnalytics = makeSliceAnalytics(this.context, this.executionContext);

        this.executionAnalytics.start();

        this.logger.info(`starting execution ${this.exId}...`);
        this.startTime = Date.now();

        await this.stores.exStore.setStatus(this.exId, 'running');
        this.client.sendAvailable();

        this.isStarted = true;

        if (this.recoverExecution) {
            await this._recoverSlicesInit();

            await Promise.all([
                this._waitForRecovery(),
                this._runDispatch(),
                this.scheduler.run(),
            ]);
        } else {
            await this._slicerInit();

            await Promise.all([
                this._runDispatch(),
                this.scheduler.run(),
            ]);
        }

        const schedulerSuccessful = this.scheduler.isFinished && this.scheduler.slicersDone;

        if (schedulerSuccessful && this.isDoneDispatching) {
            this.logger.debug(`execution ${this.exId} is done processing slices`);
            this.isDoneProcessing = true;
            await this._waitForPendingSlices();
        } else if (!this.isShuttdown) {
            this.logger.debug(`execution ${this.exId} did not finish correctly`);
        }
    }

    async _runDispatch() {
        await pWhilst(() => !this.workersHaveConnected, () => Promise.delay(100));

        this.isDoneDispatching = false;

        this.dispatchQueue.start();

        this.logger.debug('dispatching slices...');

        await pWhilst(() => {
            // stop dispatching
            if (this.isExecutionDone) return false;

            if (!this.scheduler.isFinished) return true;

            const queueSize = this.dispatchQueue.size + this.dispatchQueue.pending;
            return queueSize > 0;
        }, async () => {
            if (this.isPaused) return Promise.delay(1000);

            const workers = this.server.workerQueueSize;
            const slices = this.scheduler.queueLength;
            const count = slices > workers ? workers : slices;

            if (count > 0) {
                return this._dispatchSlices();
            }

            if (!workers && !this.isShuttingDown) {
                return this.server.onceWithTimeout('worker:enqueue', 1000);
            }

            return Promise.delay(100);
        });

        await this.dispatchQueue.onIdle();

        this.isDoneDispatching = true;
    }

    async _dispatchSlices() {
        const slices = this.scheduler.getSlices(this.server.workerQueueSize);

        slices.forEach((slice) => {
            const workerId = this.server.dequeueWorker(slice);
            if (!workerId) {
                this.scheduler.enqueueSlice(slice, true);
                return;
            }

            this.logger.trace(`add dispatch slice ${slice.slice_id} for worker ${workerId} to queue`);

            // add it the queue
            this.dispatchQueue
                .add(() => this._dispatchSlice(slice, workerId))
                .catch((err) => {
                    this.logger.error('dispatch slice error', err);
                });
        });

        if (this.dispatchQueue.pending === 0) {
            await this.dispatchQueue.onEmpty();
        } else {
            await Promise.delay(100);
        }
    }

    async _dispatchSlice(slice, workerId) {
        const sliceId = slice.slice_id;

        if (!slice._created) {
            slice._created = new Date().toISOString();
            await this.stores.stateStore.createState(this.exId, slice, 'start');
        }

        const dispatched = await this.server.dispatchSlice(slice, workerId);

        if (dispatched) {
            this.logger.debug(`dispatched slice ${sliceId} to worker ${workerId}`);
            this.pendingSlices += 1;
        } else {
            this.logger.warn(`worker "${workerId}" is not available to process slice ${sliceId}`);
            this.scheduler.enqueueSlice(slice, true);
        }
    }

    async _slicerInit() {
        const {
            logger,
            context,
        } = this;

        const maxRetries = _.get(this.executionContext, 'config.max_retries', 3);
        const retryOptions = {
            max_tries: maxRetries,
            throw_original: true,
            interval: 100,
        };

        const slicers = await retry(() => {
            const executionContext = _.cloneDeep(this.executionContext);
            const startingPoints = this.startingPoints ? _.cloneDeep(this.startingPoints) : [];

            return this.executionContext.slicer.newSlicer(
                context,
                executionContext,
                startingPoints,
                logger
            );
        }, retryOptions);

        await this.scheduler.registerSlicers(slicers);
    }

    async _recoverSlicesInit() {
        this.recover = makeExecutionRecovery(
            this.context,
            this.terminalError,
            this.stores.stateStore,
            this.executionContext
        );

        await this.recover.initialize();

        this.logger.info(`execution: ${this.exId} is starting in recovery mode`);

        const slicers = await this.recover.newSlicer();

        await this.scheduler.registerSlicers(slicers, true);
    }

    async _waitForRecovery() {
        if (this.recoveryComplete) return;

        await new Promise((resolve) => {
            this.events.once('execution:recovery:complete', (startingPoints) => {
                this.logger.trace('recovery starting points', startingPoints);
                this.startingPoints = startingPoints;
                resolve();
            });
        });

        if (_.get(this.startingPoints, '_exit') === true) {
            this.recoveryComplete = this.recover.recoveryComplete;
            this.scheduler.recovering = false;
            this.logger.warn('execution recovery has been marked as completed');
            return;
        }

        await this._slicerInit();

        if (this.recover.recoveryComplete) {
            this.logger.info(`execution ${this.exId} finished its recovery`);
        } else {
            this.logger.warn(`execution ${this.exId} failed to finish its recovery`);
        }

        this.recoveryComplete = this.recover.recoveryComplete;
    }

    async _finishExecution() {
        if (this.isExecutionFinished) return;

        this._logFinishedJob();

        try {
            await this._updateExecutionStatus();
        } catch (err) {
            /* istanbul ignore next */
            const errMsg = parseError(err);
            this.logger.error(`execution ${this.exId} has run to completion but the process has failed while updating the execution status, slicer will soon exit, error: ${errMsg}`);
        }

        this.isExecutionFinished = true;
        this._endExecution();
    }

    _endExecution() {
        this.isExecutionDone = true;
        this.scheduler.cleanup();
    }

    async _updateExecutionStatus() {
        // if this.slicerFailed is true, slicer has already been marked as failed
        if (this.slicerFailed) return;

        const { logger } = this;
        const { exStore } = this.stores;

        const executionStats = this.executionAnalytics.getAnalytics();

        if (!this.isDoneProcessing) {
            // if status is stopping or stopped, only update the execution metadata
            const status = await exStore.getStatus(this.exId);
            const isStopping = status === 'stopping' || status === 'stopped';
            if (isStopping) {
                const metaData = exStore.executionMetaData(executionStats);
                logger.debug(`execution is set to ${status}, status will not be updated`);
                await exStore.update(this.exId, metaData);
                return;
            }

            const errMsg = `execution ${this.exId} received shutdown before the slicer could complete, setting status to "terminated"`;
            const metaData = exStore.executionMetaData(executionStats, errMsg);
            logger.error(errMsg);
            await exStore.setStatus(this.exId, 'terminated', metaData);
            return;
        }

        const [errors, started] = await Promise.all([
            this._checkExecutionErrorState(),
            this._checkExecutionStartedState()
        ]);

        if (errors > 0 || started > 0) {
            const errMsg = this._formartExecutionFailure({ errors, started });
            const errorMeta = exStore.executionMetaData(executionStats, errMsg);
            logger.error(errMsg);
            await exStore.setStatus(this.exId, 'failed', errorMeta);
            return;
        }

        const metaData = exStore.executionMetaData(executionStats);
        logger.info(`execution ${this.exId} has completed`);
        await exStore.setStatus(this.exId, 'completed', metaData);
    }

    _logFinishedJob() {
        const endTime = Date.now();
        const elapsed = endTime - this.startTime;
        const time = elapsed < 1000 ? 1 : Math.round((elapsed) / 1000);

        this.executionAnalytics.set('job_duration', time);

        if (this.collectAnalytics) {
            this.slicerAnalytics.analyzeStats();
        }

        this.logger.info(`execution ${this.exId} has finished in ${time} seconds`);
    }

    _formartExecutionFailure({ started, errors }) {
        let errMsg = `execution: ${this.exId}`;

        const startedMsg = started === 1 ? `${started} slice stuck in started` : `${started} slices stuck in started`;
        const errorsMsg = errors === 1 ? `${errors} slice failure` : `${errors} slice failures`;

        if (errors === 0 && started > 0) {
            errMsg += ` had ${startedMsg}`;
        } else {
            errMsg += ` had ${errorsMsg}`;
            if (started > 0) {
                errMsg += `, and had ${startedMsg}`;
            }
        }

        errMsg += ' during processing';
        return errMsg;
    }

    _checkExecutionErrorState() {
        const query = `ex_id:${this.exId} AND state:error`;
        return this.stores.stateStore.count(query, 0);
    }

    _checkExecutionStartedState() {
        const query = `ex_id:${this.exId} AND state:start`;
        return this.stores.stateStore.count(query, 0);
    }

    async _waitForWorkersToExit() {
        if (!this.server.onlineClientCount) return;

        const timeoutOutAt = this.workerDisconnectTimeout + Date.now();

        const logWaitingForWorkers = _.debounce(() => {
            this.logger.debug(`waiting for ${this.server.onlineClientCount} to go offline`);
        }, 1000, {
            leading: true,
        });

        const checkOnlineCount = async () => {
            if (this.isExecutionFinished) {
                this.logger.trace('execution finished while waiting for workers to go offline');
                return;
            }

            if (!this.client.ready) return;

            if (!this.server.onlineClientCount) {
                this.logger.trace('workers all workers have disconnected');
                return;
            }

            const now = Date.now();
            if (now > timeoutOutAt) {
                return;
            }

            logWaitingForWorkers();

            await Promise.delay(100);
            await checkOnlineCount();
        };

        await checkOnlineCount();
    }

    async _waitForPendingSlices() {
        const logPendingSlices = _.debounce(() => {
            this.logger.debug(`waiting for ${this.pendingSlices} slices to finish`);
        }, 1000, {
            leading: true,
        });

        const checkPendingSlices = async () => {
            if (this.isShuttingDown) return;

            if (!this.pendingSlices) {
                this.logger.debug('all pending slices are done');
                return;
            }

            logPendingSlices();

            await Promise.delay(100);
            await checkPendingSlices();
        };

        await checkPendingSlices();
    }

    _waitForExecutionFinished() {
        const timeout = Math.round(this.shutdownTimeout * 0.8);
        const shutdownAt = timeout + Date.now();

        const logShuttingDown = _.debounce(() => {
            this.logger.debug('shutdown is waiting for execution to finish...');
        }, 1000, {
            leading: true,
        });

        const checkExecution = async () => {
            if (this.isExecutionDone) {
                this.logger.trace('execution finished while shutting down');
                return null;
            }

            if (!this.client.ready) return null;

            const now = Date.now();
            if (now > shutdownAt) {
                this.logger.error(`Shutdown timeout of ${timeout}ms waiting for execution ${this.exId} to finish...`);
                return null;
            }

            logShuttingDown();
            await Promise.delay(100);
            return checkExecution();
        };

        return checkExecution();
    }

    // verify the execution can be set to running
    async _verifyExecution() {
        const { exStore } = this.stores;
        let error;

        const terminalStatuses = exStore.getTerminalStatuses();
        const runningStatuses = exStore.getRunningStatuses();
        const status = await exStore.getStatus(this.exId);

        if (_.includes(terminalStatuses, status)) {
            error = new Error(`Execution ${this.exId} was starting in terminal status, sending execution:finished event to cluster master`);
        } else if (_.includes(runningStatuses, status)) {
            error = new Error(`Execution ${this.exId} was starting in running status, sending execution:finished event to cluster master`);
        } else {
            return true;
        }

        await this.client.sendExecutionFinished(error.message);

        this.logger.warn('Unable to verify execution on initialization', error.stack);
        return false;
    }

    _checkAndUpdateExecutionState() {
        const probationWindow = this.executionContext.config.probation_window;
        let watchDogSet = false;
        let errorCount;
        let processedCount;

        return async () => {
            if (watchDogSet) return;
            watchDogSet = true;
            const analyticsData = this.executionAnalytics.getAnalytics();
            // keep track of how many slices have been processed and failed
            errorCount = analyticsData.failed;
            processedCount = analyticsData.processed;
            await this.setFailingStatus();
            const { exStore } = this.stores;

            this.watcher = setInterval(() => {
                const currentAnalyticsData = this.executionAnalytics.getAnalytics();
                const currentErrorCount = currentAnalyticsData.failed;
                const currentProcessedCount = currentAnalyticsData.processed;
                const errorCountTheSame = currentErrorCount === errorCount;
                const slicesHaveProcessedSinceError = currentProcessedCount > processedCount;

                if (errorCountTheSame && slicesHaveProcessedSinceError) {
                    clearInterval(this.watcher);
                    this.logger.info(`No slice errors have occurred within execution: ${this.exId} will be set back to 'running' state`);
                    exStore.setStatus(this.exId, 'running');
                    return;
                }
                errorCount = currentErrorCount;
                processedCount = currentProcessedCount;
            }, probationWindow);
        };
    }

    _startWorkConnectWatchDog() {
        clearTimeout(this.workerConnectTimeoutId);

        const timeout = this.context.sysconfig.teraslice.slicer_timeout;
        const err = new Error(`No workers have connected to slicer in the allotted time: ${timeout} ms`);

        this.workerConnectTimeoutId = setTimeout(() => {
            clearTimeout(this.workerConnectTimeoutId);

            if (this.isShuttingDown) return;
            if (this.workersHaveConnected) return;

            this.logger.warn(`A worker has not connected to a slicer for ex: ${this.exId}, shutting down execution`);

            this.terminalError(err);
        }, timeout);
    }

    _startWorkerDisconnectWatchDog() {
        clearTimeout(this.workerDisconnectTimeoutId);

        if (this.isShuttingDown) return;
        if (this.server.onlineClientCount > 0) return;

        const err = new Error(`All workers from workers from ${this.exId} have disconnected`);

        this.workerDisconnectTimeoutId = setTimeout(() => {
            clearTimeout(this.workerDisconnectTimeoutId);

            if (this.isShuttingDown) return;
            if (this.server.onlineClientCount > 0) return;

            this.terminalError(err);
        }, this.workerDisconnectTimeout);
    }
}

module.exports = ExecutionController;
