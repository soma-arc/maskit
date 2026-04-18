import { refineUnknownMask } from '../bq-cpu.mjs';

self.addEventListener('message', (event) => {
    const { requestId, renderState, candidateMaskBuffer, unknownPixels, options } = event.data;

    try {
        const candidateMask = new Uint8Array(candidateMaskBuffer);
        const refined = refineUnknownMask(renderState, candidateMask, unknownPixels, options);

        self.postMessage(
            {
                requestId,
                refinedMaskBuffer: refined.refinedMask.buffer,
                resolvedCount: refined.resolvedCount,
                resolvedTrue: refined.resolvedTrue,
                resolvedFalse: refined.resolvedFalse,
            },
            [refined.refinedMask.buffer],
        );
    } catch (error) {
        self.postMessage({
            requestId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
});
