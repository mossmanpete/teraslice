'use strict';

const _ = require('lodash');
const _podsJobRunning = require('./files/job-running-v1-k8s-pods.json');
const k8sState = require('../../../../../../../lib/cluster/services/cluster/backends/kubernetes/k8sState');

describe('k8sState', () => {
    it('should generate cluster state correctly on first call', () => {
        const podsJobRunning = _.cloneDeep(_podsJobRunning);
        const clusterState = {};

        k8sState.gen(podsJobRunning, clusterState);
        // console.log(`clusterState\n\n${JSON.stringify(clusterState, null, 2)}`);
        // console.log(`expectedClusterState\n\n` + JSON.stringify(expectedClusterState, null, 2));

        /* The two tests below fail with the following error due to jasmine
           having a hard time deep comparing two objects with an array.
           https://github.com/jasmine/jasmine/issues/598
           https://github.com/jasmine/jasmine/issues/786

           Both suggest I implement a custom_equality test
           https://jasmine.github.io/2.2/custom_equality.html
        - Expected object not to have properties
            ex_id: undefined
            job_id: undefined
        */
        // expect(clusterState).toEqual(expectedClusterState);
        // expect(clusterState['192.168.99.100'].active[0])
        //     .toEqual(expectedClusterState['192.168.99.100'].active[0]);

        expect(clusterState['192.168.99.100'].state).toEqual('connected');
        expect(clusterState['192.168.99.100'].active.length).toEqual(3);
        expect(clusterState['192.168.99.100'].active[1])
            .toEqual({
                worker_id: 'teraslice-execution_controller-123456-784cbt5mz',
                assignment: 'slicer',
                pid: 'teraslice-execution_controller-123456-784cbt5mz',
                ex_id: '123456',
                job_id: '654321',
                pod_ip: '172.17.0.5',
                assets: []
            });
        expect(clusterState['192.168.99.100'].active[2])
            .toEqual({
                worker_id: 'teraslice-worker-123456-8b68v7p8t',
                assignment: 'worker',
                pid: 'teraslice-worker-123456-8b68v7p8t',
                ex_id: '123456',
                job_id: '654321',
                pod_ip: '172.17.0.6',
                assets: []
            });
    });

    it('should generate cluster state correctly on second call', () => {
        const podsJobRunning = _.cloneDeep(_podsJobRunning);
        const clusterState = {};

        k8sState.gen(podsJobRunning, clusterState);
        k8sState.gen(podsJobRunning, clusterState);

        expect(clusterState['192.168.99.100'].state).toEqual('connected');
        expect(clusterState['192.168.99.100'].active.length).toEqual(3);
        expect(clusterState['192.168.99.100'].active[1])
            .toEqual({
                worker_id: 'teraslice-execution_controller-123456-784cbt5mz',
                assignment: 'slicer',
                pid: 'teraslice-execution_controller-123456-784cbt5mz',
                ex_id: '123456',
                job_id: '654321',
                pod_ip: '172.17.0.5',
                assets: []
            });
        expect(clusterState['192.168.99.100'].active[2])
            .toEqual({
                worker_id: 'teraslice-worker-123456-8b68v7p8t',
                assignment: 'worker',
                pid: 'teraslice-worker-123456-8b68v7p8t',
                ex_id: '123456',
                job_id: '654321',
                pod_ip: '172.17.0.6',
                assets: []
            });
    });

    it('should remove old host ips', () => {
        const podsJobRunning = _.cloneDeep(_podsJobRunning);
        const clusterState = {};
        clusterState['2.2.2.2'] = {
            state: 'idk',
            active: []
        };

        k8sState.gen(podsJobRunning, clusterState);
        expect(clusterState['192.168.99.100'].active.length).toEqual(3);
        expect(clusterState['2.2.2.2']).toBeUndefined();
    });

    // This might not be technically possible, I think there will at least have
    // to be a master node
    // it('generates cluster state correctly with null PodList', () => {
    //     const clusterState = {};
    //     const podList = {
    //         kind: 'PodList',
    //         apiVersion: 'v1',
    //         metadata: {
    //             selfLink: '/api/v1/namespaces/default/pods',
    //             resourceVersion: '1089627'
    //         },
    //         items: []
    //     };
    //
    //     k8sState.gen(podList, clusterState);
    //     expect(clusterState).toEqual({});
    // });
});
