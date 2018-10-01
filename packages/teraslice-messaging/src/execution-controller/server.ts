import _ from 'lodash';
import debugFn from 'debug';
import Queue from '@terascope/queue';
import { Slice } from '@terascope/teraslice-types';
import * as core from '../messenger';
import * as i from './interfaces';

const debug = debugFn('teraslice-messaging:execution-controller:server');

export class Server extends core.Server {
    private _activeWorkers: string[];
    queue: Queue;

    constructor(opts: i.ServerOptions) {
        const {
            port,
            actionTimeout,
            pingInterval,
            pingTimeout,
            networkLatencyBuffer,
            workerDisconnectTimeout,
        } = opts;

        if (!_.isNumber(workerDisconnectTimeout)) {
            throw new Error('ExecutionController.Server requires a valid workerDisconnectTimeout');
        }

        super({
            port,
            actionTimeout,
            pingInterval,
            pingTimeout,
            networkLatencyBuffer,
            clientDisconnectTimeout: workerDisconnectTimeout,
            serverName: 'ExecutionController',
        });

        this.queue = new Queue();
        this._activeWorkers = [];
    }

    async start() {
        this.on('connection', (msg) => {
            this.onConnection(msg.clientId, msg.payload as SocketIO.Socket);
        });

        this.onClientUnavailable((workerId) => {
            this._workerRemove(workerId);
        });

        this.onClientDisconnect((workerId) => {
            _.pull(this._activeWorkers, workerId);
            this._workerRemove(workerId);
        });

        this.onClientAvailable((workerId) => {
            this._workerEnqueue(workerId);
        });

        await this.listen();
    }

    async shutdown() {
        this.queue.each((worker: i.Worker) => {
            this.queue.remove(worker.workerId, 'workerId');
        });

        this._activeWorkers = [];

        await super.shutdown();
    }

    dequeueWorker(slice: Slice): string|null {
        const requestedWorkerId = slice.request.request_worker;
        return this._workerDequeue(requestedWorkerId);
    }

    async dispatchSlice(slice: Slice, workerId: string): Promise<boolean> {
        const isAvailable = _.get(this._clients, [workerId, 'state']) === core.ClientState.Available;
        if (!isAvailable) {
            debug(`worker ${workerId} is not available`);
            return false;
        }

        const sliceId = slice.slice_id;

        // first assume the slice is dispatched
        this._activeWorkers = _.union(this._activeWorkers, [workerId]);

        let dispatched = false;

        try {
            const response = await this.send(workerId, 'execution:slice:new', slice);
            dispatched = _.get(response, 'payload.willProcess', false);
        } catch (error) {
            debug('got error when dispatching slice', error, slice);
        }

        if (!dispatched) {
            debug(`failure to dispatch slice ${sliceId} to worker ${workerId}`);
            _.pull(this._activeWorkers, workerId);
        } else {
            this.updateClientState(workerId, {
                state: core.ClientState.Unavailable,
            });
        }

        return dispatched;
    }

    onSliceSuccess(fn: (workerId: string, payload: i.SliceCompletePayload) => {}) {
        this.on('slice:success', (msg) => {
            _.defer(() => {
                fn(msg.clientId, msg.payload);
            });
        });
    }

    onSliceFailure(fn: (workerId: string, payload: i.SliceCompletePayload) => {}) {
        this.on('slice:failure', (msg) => {
            _.defer(() => {
                fn(msg.clientId, msg.payload);
            });
        });
    }

    sendExecutionFinishedToAll(exId: string) {
        return this.sendToAll('execution:finished', { exId }, {
            response: false,
            volatile: false,
        });
    }

    get activeWorkers(): string[] {
        return _.clone(this._activeWorkers);
    }

    get workerQueueSize(): number {
        return this.queue.size();
    }

    private onConnection(workerId: string, socket: SocketIO.Socket) {
        socket.on('worker:slice:complete', this.handleResponse('worker:slice:complete', async (msg) => {
            const { payload } = msg;
            const sliceId = _.get(payload, 'slice.slice_id');

            if (payload.error) {
                this.emit('slice:failure', { clientId: workerId, payload });
            } else {
                this.emit('slice:success', { clientId: workerId, payload });
            }

            _.pull(this._activeWorkers, workerId);

            return _.pickBy({
                recorded: true,
                slice_id: sliceId,
            });
        }));
    }

    private _workerEnqueue(workerId: string): boolean {
        if (!workerId) {
            throw new Error('Failed to enqueue invalid worker');
        }

        const exists = this.queue.exists('workerId', workerId);
        if (!exists) {
            this.queue.enqueue({ workerId });
        }

        this.emit('worker:enqueue', { clientId: workerId, payload: {} });
        return exists;
    }

    private _workerDequeue(requestedWorkerId?: string): string | null {
        let workerId: string|null;

        if (requestedWorkerId) {
            const worker = this.queue.extract('workerId', requestedWorkerId);
            workerId = worker ? worker.workerId : null;
        } else {
            const worker = this.queue.dequeue();
            workerId = worker ? worker.workerId : null;
        }

        if (workerId != null) {
            _.pull(this._activeWorkers, workerId);
            this.emit('worker:dequeue', { clientId: workerId, payload: {} });
        }

        return workerId;
    }

    private _workerRemove(workerId: string): boolean {
        if (!workerId) return false;

        this.queue.remove(workerId, 'workerId');

        this.emit('worker:dequeue', { clientId: workerId, payload: {} });
        return true;
    }
}
