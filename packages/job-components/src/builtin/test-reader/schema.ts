import { TestReaderConfig } from './interfaces';
import { ConvictSchema } from '../../operations';

export default class Schema extends ConvictSchema<TestReaderConfig> {
    build() {
        return {
            fetcher_data_file_path: {
                default: null,
                doc: 'File to path to JSON array of data records. Defaults to ./data/fetcher-data.json this directroy',
                format: 'optional_String'
            },
            slicer_data_file_path: {
                default: null,
                doc: 'File to path to JSON array of slice requests. Defaults to ./data/slicer-data.json this directroy',
                format: 'optional_String'
            },
        };
    }
}
