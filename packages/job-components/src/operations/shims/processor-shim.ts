import { Context, LegacyProcessor, SliceRequest, ProcessorFn, ValidatedJobConfig } from '../../interfaces';
import DataEntity, { DataEntityList } from '../data-entity';
import ProcessorCore from '../core/processor-core';
import ConvictSchema from '../convict-schema';
import { ProcessorModule } from '../interfaces';

export default function processorShim<S = any>(legacy: LegacyProcessor): ProcessorModule {
    return {
        Processor: class LegacyProcessorShim extends ProcessorCore {
            private processorFn: ProcessorFn<DataEntity[]>|undefined;

            async initialize() {
                this.processorFn = await legacy.newProcessor(this.context, this.opConfig, this.executionConfig);
            }

            async handle(input: DataEntityList, sliceRequest: SliceRequest): Promise<DataEntityList> {
                if (this.processorFn != null) {
                    const result = await this.processorFn(input.toArray(), this.logger, sliceRequest);
                    return DataEntity.makeList(result);
                }

                throw new Error('Processor has not been initialized');
            }
        },
        Schema: class LegacySchemaShim extends ConvictSchema<S> {
            validate(inputConfig: any) {
                const opConfig = super.validate(inputConfig);
                if (legacy.selfValidation) {
                    legacy.selfValidation(opConfig);
                }
                return opConfig;
            }

            validateJob(job: ValidatedJobConfig): void {
                if (legacy.crossValidation) {
                    legacy.crossValidation(job, this.context.sysconfig);
                }
            }

            build(context?: Context) {
                return legacy.schema(context);
            }
        }
    };
}
