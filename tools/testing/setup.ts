import { after } from 'node:test';
import { disposeGpu } from '../../packages/render/dist/gpu.js';

after(disposeGpu);
