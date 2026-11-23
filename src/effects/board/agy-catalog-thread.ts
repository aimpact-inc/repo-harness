// Worker thread entry of one agy catalog read; readAgyCatalogOffThread in seats-configuration.ts starts it by URL.
// The probe waits on its child synchronously, so the operator reads it here and keeps its HTTP event loop free.

import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { probeAgySeat } from './seats-configuration';

if (!isMainThread && parentPort) parentPort.postMessage(probeAgySeat(workerData.env));
