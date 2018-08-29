# Kubernetes Clustering

** KUBERNETES SUPPORT IS STILL A WORK IN PROGRESS
These notes are intended for contributors only **

Teraslice supports the use of Kubernetes as a cluster manager.  The supported
versions of Kubernetes is:

* `1.10.*`

## Setup

You need Elasticsearch running and listening on a port accessible by the
Teraslice master and worker nodes.  In the case of minikube based deployments
(dev/test only) you'll need to make ES listen on your VirtualBox interface.  The
IP address of that interface is what you need to set as:

    `terafoundation.connectors.elasticsearch.default.host`

in both the `teraslice-master` and `teraslice-worker` ConfigMaps.

### `default` ServiceAccount Binding

As a development workaround, cluster admin privileges should be added to the
default ServiceAccount in the default namespace using the following command:

```
cd example/k8s
kubectl create -f teraslice-default-binding.yaml
```

This may not be appropriate for production environments.

### Kubernetes Specific Configuration Settings

|        Configuration         |                                                                         Description                                                                         |  Type  |  Notes   |
|:----------------------------:|:-----------------------------------------------------------------------------------------------------------------------------------------------------------:|:------:|:--------:|
|       kubernetes_image       |                                                      Name of docker image, default: `teraslice:k8sdev`                                                      | String | optional |
| kubernetes_image_pull_secret |                                                     Secret used to pull docker images from private repo                                                     | String | optional |
|  kubernetes_config_map_name  | Name of the configmap used by worker and executcion_controller containers for config.  If this is not provided, the default will be `<CLUSTER_NAME>-worker` | String | optional |

# Teraslice Job Properties

Support for Kubernetes based clustering adds additional properties to a
Teraslice job definition.  These are outlined below.

## Resources

It is possible to set CPU and memory resource constraints for your Teraslice
workers that translate to Kubernetes resource constraints.  Currently you
can specify optional integer values on your job as shown below. The `cpu`
setting is in vcores and the `memory` setting is in bytes.

```
"cpu": 1,
"memory": 2147483648
```

Setting `cpu` will result in the Kubernetes `resources.requests.cpu` and
`resources.limit.cpu` being set to `cpu` value provided.  Setting `memory`
will result in the Kubernetes `resources.requests.memory` and
`resources.limit.memory` being set to the `memory` value provided. See the
[Kubernetes Resource docs](https://kubernetes.io/docs/concepts/configuration/manage-compute-resources-container/)
for further details on how Kubernetes interprets these values.

## Node Affinity by Targets

If you need the workers (and execution controller) of your job to execute on
specific set of nodes, you can use the Teraslice `targets` property on your
job. You can specify one or more targets that will use [Kubernetes Node Affinity](
https://kubernetes.io/docs/concepts/configuration/assign-pod-node/#affinity-and-anti-affinity)
to force nodes onto specific nodes.  The targets specified here will be required
using `requiredDuringSchedulingIgnoredDuringExecution`.

```
"targets": [
    {"key": "zone", "value": "west"}
],
```

For each entry in `targets` you provide, there will be a corresponding
Kubernetes constraint, like the one shown below, added to your workers.

```
        nodeSelectorTerms:
        - matchExpressions:
          - key: <KEY>
            operator: In
            values:
            - <VALUE>
```

## Attach existing volumes

One or more volumes can be specified on your job and these volumes will be
attached to your worker and execution controller pods at runtime.  The volumes
and their volume claims must exist prior to job execution.  Note that the `name`
property should be the name of the Kubernetes `persistentVolumeClaim`.  The
`path` is where the volume will be mounted within the containers in your pod.

```
"volumes": [
    {"name": "teraslice-data1", "path": "/data"}
],
```

# Makefile

There is a `Makefile` I use to help bootstrap Teraslice and do repetitive tasks,
you can type `make` to see all of the possible targets.

The standard minikube based dev workflow is:

```
cd examples/k8s
export NAMESPACE=ts-dev1
export TERASLICE_K8S_IMAGE=teraslice-k8sdev:1
make build
make setup-all
make show
make register
make example
```

then when you need to make another change to Teraslice, redeploy and run a new
job:

```
make destroy
export TERASLICE_K8S_IMAGE=teraslice-k8sdev:2
make build
make setup
make register
make example
```