'use strict';

const _ = require('lodash');
const Promise = require('bluebird');
const misc = require('../../misc');
const { waitForJobStatus } = require('../../wait');
const { resetState, testJobLifeCycle, runEsJob } = require('../../helpers');

const teraslice = misc.teraslice();

describe('reindex', () => {
    beforeAll(() => resetState());

    it('should work for simple case', async () => {
        const jobSpec = misc.newJob('reindex');
        jobSpec.name = 'basic reindex';
        jobSpec.operations[1].index = 'test-reindex-10';

        const count = await runEsJob(jobSpec, 'test-reindex-10');
        expect(count).toBe(10);
    });

    it('should work when no data is returned with lucene query', (done) => {
        const jobSpec = misc.newJob('reindex');
        jobSpec.name = 'basic reindex';
        jobSpec.operations[1].index = 'test-reindex-bad-query';
        jobSpec.operations[0].query = 'bytes:>=99999999';

        teraslice.jobs.submit(jobSpec)
            .then((job) => {
                expect(job).toBeDefined();
                expect(job.id()).toBeDefined();

                return waitForJobStatus(job, 'completed');
            })
            .then((status) => {
                expect(status).toEqual('completed');
                return misc.indexStats('test-reindex-bad-query')
                    .catch((errResponse) => {
                        // the job should  be marked as completed but no new index
                        // as there are no records
                        const reason = _.get(errResponse, 'body.error.reason');
                        expect(reason).toEqual('no such index');
                    });
            })
            .catch(fail)
            .finally(() => { done(); });
    });

    it('should collect cluster level stats', (done) => {
        teraslice.cluster.stats()
            .then((stats) => {
                expect(stats.controllers.processed).toBeGreaterThan(0);
                expect(stats.controllers.failed).toBe(0);
                expect(stats.controllers.queued).toBeDefined();
                expect(stats.controllers.job_duration).toBeGreaterThan(0);
                expect(stats.controllers.workers_joined).toBeGreaterThan(0);
                expect(stats.controllers.workers_disconnected).toBeDefined();
                expect(stats.controllers.workers_reconnected).toBeDefined();
                // executions: total, failed, active?
                // exceptions?
            })
            .catch(fail)
            .finally(() => { done(); });
    });

    it('should complete after lifecycle changes', async () => {
        const jobSpec = misc.newJob('reindex');
        jobSpec.name = 'reindex after lifecycle changes';

        // Job needs to be able to run long enough to cycle
        jobSpec.operations[0].index = 'example-logs-1000';
        jobSpec.operations[1].index = 'test-reindex-lifecycle';

        await testJobLifeCycle(jobSpec);

        const stats = await misc.indexStats('test-reindex-lifecycle');
        expect(stats.count).toBe(1000);
    });

    it('can support different recovery mode cleanup=errors', (done) => {
        const errorStates = '/ex/testex-errors/_recover?cleanup=errors';

        teraslice.cluster.post(errorStates)
            .then(job => teraslice.jobs.wrap(job.job_id))
            .then(job => waitForJobStatus(job, 'completed'))
            .then(() => misc.indexStats('test-recovery-100'))
            .then(stats => expect(stats.count).toEqual(100))
            .catch(fail)
            .finally(() => { done(); });
    });

    it('can support different recovery mode cleanup=all', (done) => {
        const allStates = '/ex/testex-all/_recover?cleanup=all';

        teraslice.cluster.post(allStates)
            .then(job => teraslice.jobs.wrap(job.job_id))
            .then(job => waitForJobStatus(job, 'completed'))
            .then(() => misc.indexStats('test-recovery-200'))
            .then(stats => expect(stats.count).toEqual(200))
            .catch(fail)
            .finally(() => { done(); });
    });

    it('should support idempotency', (done) => {
        const iterations = 3;

        const jobSpec = misc.newJob('reindex');
        jobSpec.name = `reindex ${iterations} times`;
        jobSpec.operations[1].index = `test-reindex-${iterations}times`;

        const jobs = _.times(iterations, () => jobSpec);

        Promise.map(jobs, async (spec) => {
            const job = await teraslice.jobs.submit(spec);
            expect(job).toBeDefined();
            expect(job.id()).toBeDefined();

            return waitForJobStatus(job, 'completed');
        })
            .then(async () => {
                const stats = await misc.indexStats(`test-reindex-${iterations}times`);

                expect(stats.count).toBe(10);
            })
            .catch(fail)
            .finally(() => { done(); });
    });
}, 60 * 1000);
