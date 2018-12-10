import { EventEmitter } from 'events';
import { isFunction, cloneDeep } from '../utils';
import {
    SlicerOperationLifeCycle,
    ExecutionConfig,
    ExecutionStats,
    Slice,
    SliceResult,
    WorkerContext
} from '../interfaces';
import { OperationLoader } from '../operation-loader';
import SlicerCore from '../operations/core/slicer-core';
import { registerApis } from '../register-apis';
import {
    EventHandlers,
    SlicerOperations,
    ExecutionContextConfig,
    SlicerMethodRegistry,
} from './interfaces';

// WeakMaps are used as a memory efficient reference to private data
const _loaders = new WeakMap<SlicerExecutionContext, OperationLoader>();
const _operations = new WeakMap<SlicerExecutionContext, SlicerOperations>();

/**
 * SlicerExecutionContext is designed to add more
 * functionality to interface with the
 * Execution Configuration and any Operation.
*/
export class SlicerExecutionContext implements SlicerOperationLifeCycle {
    readonly config: ExecutionConfig;
    readonly context: WorkerContext;

    /**
     * A list of assetIds available to the job.
     * This will be replaced by `resolvedAssets`
    */
    readonly assetIds: string[] = [];

    readonly exId: string;
    readonly jobId: string;

    /** The terafoundation EventEmitter */
    readonly events: EventEmitter;

    private _handlers: EventHandlers = {};

    private _methodRegistry: SlicerMethodRegistry = {
        onSliceComplete: new Set(),
        onSliceDispatch: new Set(),
        onSliceEnqueued: new Set(),
        onExecutionStats: new Set(),
    };

    private readonly _slicer: SlicerCore;

    constructor(config: ExecutionContextConfig) {
        this.events = config.context.apis.foundation.getSystemEvents();

        this._handlers['execution:add-to-lifecycle'] = (op: SlicerOperationLifeCycle) => {
            this.addOperation(op);
        };

        this.events.on('execution:add-to-lifecycle', this._handlers['execution:add-to-lifecycle']);

        const executionConfig = cloneDeep(config.executionConfig);
        const loader = new OperationLoader({
            terasliceOpPath: config.terasliceOpPath,
            assetPath: config.context.sysconfig.teraslice.assets_directory,
        });

        registerApis(config.context, executionConfig, config.assetIds);
        this.context = config.context as WorkerContext;

        this.assetIds = config.assetIds || [];

        this.config = executionConfig;
        this.exId = executionConfig.ex_id;
        this.jobId = executionConfig.job_id;

        _loaders.set(this, loader);

        _operations.set(this, new Set());

        const readerConfig = this.config.operations[0];
        const mod = loader.loadReader(readerConfig._op, this.assetIds);

        const op = new mod.Slicer(this.context, cloneDeep(readerConfig), this.config);
        this._slicer = op;
        this.addOperation(op);

        this.resetMethodRegistry();
    }

    /** The instance of a "Slicer" */
    slicer<T extends SlicerCore = SlicerCore>(): T {
        return this._slicer as T;
    }

    /**
     * Called to initialize all of the registered operations available to the Execution Controller
    */
    async initialize(recoveryData: object[] = []) {
        const promises = [];
        for (const op of this.getOperations()) {
            promises.push(op.initialize(recoveryData));
        }

        await Promise.all(promises);
    }

    /**
     * Called to cleanup all of the registered operations available to the Execution Controller
    */
    async shutdown() {
        const promises = [];
        for (const op of this.getOperations()) {
            promises.push(op.shutdown());
        }

        await Promise.all(promises);

        Object.keys(this._handlers)
            .forEach((event) => {
                const listener = this._handlers[event];
                this.events.removeListener(event, listener);
            });
    }

    onExecutionStats(stats: ExecutionStats) {
        this.runMethod('onExecutionStats', stats);
    }

    onSliceEnqueued(slice: Slice) {
        this.runMethod('onSliceEnqueued', slice);
    }

    onSliceDispatch(slice: Slice) {
        this.runMethod('onSliceDispatch', slice);
    }

    onSliceComplete(result: SliceResult): void {
        this.runMethod('onSliceComplete', result);
    }

    getOperations() {
        const ops = _operations.get(this) as SlicerOperations;
        return ops.values();
    }

    private addOperation(op: SlicerOperationLifeCycle) {
        const ops = _operations.get(this) as SlicerOperations;
        ops.add(op);

        this.resetMethodRegistry();
    }

    private runMethod<T>(method: string, arg: T) {
        const set = this._methodRegistry[method] as Set<number>;
        if (set.size === 0) return;

        let index = 0;
        for (const operation of this.getOperations()) {
            if (set.has(index)) {
                operation[method](arg);
            }
            index++;
        }
    }

    private resetMethodRegistry() {
        for (const method of Object.keys(this._methodRegistry)) {
            this._methodRegistry[method].clear();
        }

        const methods = Object.keys(this._methodRegistry);

        let index = 0;
        for (const op of this.getOperations()) {
            for (const method of methods) {
                if (isFunction(op[method])) {
                    this._methodRegistry[method].add(index);
                }
            }

            index++;
        }
    }
}
