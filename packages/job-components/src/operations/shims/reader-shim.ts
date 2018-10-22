import { Context, OpConfig, LegacyExecutionContext, LegacyReader, SliceRequest, SlicerFns, ReaderFn } from '../../interfaces';
import DataEntity, { DataEntityList } from '../data-entity';
import FetcherCore from '../core/fetcher-core';
import ParallelSlicer from '../parallel-slicer';
import ConvictSchema from '../convict-schema';
import {
    SchemaConstructor,
    FetcherConstructor,
    SlicerConstructor,
} from '../interfaces';
import { isInteger } from '../../utils';

export default function readerShim(legacy: LegacyReader): ReaderModule {
    return {
        Slicer: class LegacySlicerShim extends ParallelSlicer  {
            private _maxQueueLength = 10000;
            private _dynamicQueueLength = false;
            private slicerFns: SlicerFns|undefined;

            async initialize(recoveryData: object[]) {
                // @ts-ignore
                const executionContext: LegacyExecutionContext = {
                    config: this.executionConfig,
                };

                if (legacy.slicerQueueLength && typeof legacy.slicerQueueLength === 'function') {
                    const result = await legacy.slicerQueueLength(executionContext);
                    if (result === 'QUEUE_MINIMUM_SIZE') {
                        this._maxQueueLength = this.executionConfig.workers;
                        this._dynamicQueueLength = true;
                    } else if (isInteger(result) && result > 0) {
                        this._maxQueueLength = result;
                    }
                }

                this.slicerFns = await legacy.newSlicer(this.context, executionContext, recoveryData, this.logger);

                await super.initialize(recoveryData);
            }

            async newSlicer() {
                if (this.slicerFns == null) {
                    throw new Error('Slicer has not been initialized');
                }
                const fn = this.slicerFns.shift();
                if (!fn) {
                    return async () => null;
                }
                return fn;
            }

            maxQueueLength() {
                if (this._dynamicQueueLength) {
                    return this.workersConnected;
                }
                return this._maxQueueLength;
            }
        },
        Fetcher: class LegacyFetcherShim extends FetcherCore {
            private fetcherFn: ReaderFn<DataEntity[]>|undefined;

            async initialize() {
                this.fetcherFn = await legacy.newReader(this.context, this.opConfig, this.executionConfig);
            }

            async handle(sliceRequest: SliceRequest): Promise<DataEntityList> {
                if (this.fetcherFn) {
                    const result = await this.fetcherFn(sliceRequest);
                    return DataEntity.makeList(result);
                }

                throw new Error('Fetcher has not been initialized');
            }
        },
        Schema: class LegacySchemaShim extends ConvictSchema {
            validate(inputConfig: any): OpConfig {
                const opConfig = super.validate(inputConfig);
                if (legacy.selfValidation) {
                    legacy.selfValidation(opConfig);
                }
                return opConfig;
            }

            build(context?: Context) {
                return legacy.schema(context);
            }
        }
    };
}

interface ReaderModule {
    Slicer: SlicerConstructor;
    Fetcher: FetcherConstructor;
    Schema: SchemaConstructor;
}