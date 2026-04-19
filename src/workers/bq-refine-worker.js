import { evaluateBqPixel, refineUnknownMask } from '../bq-cpu.mjs';

self.addEventListener('message', (event) => {
    const { requestId, renderState, candidateMaskBuffer, unknownIndicesBuffer, options, action } =
        event.data;

    try {
        const unknownIndices = unknownIndicesBuffer ? new Uint32Array(unknownIndicesBuffer) : null;

        if (action === 'resolveUnknownPixels') {
            if (!unknownIndices) {
                throw new Error('resolveUnknownPixels requires unknownIndicesBuffer');
            }

            const resolvedValues = new Uint8Array(unknownIndices.length);
            let resolvedTrue = 0;
            let resolvedFalse = 0;

            for (let index = 0; index < unknownIndices.length; index += 1) {
                const nextValue = evaluateBqPixel(renderState, unknownIndices[index], options)
                    ? 1
                    : 0;
                resolvedValues[index] = nextValue;
                if (nextValue === 1) {
                    resolvedTrue += 1;
                } else {
                    resolvedFalse += 1;
                }
            }

            self.postMessage(
                {
                    requestId,
                    resolvedValuesBuffer: resolvedValues.buffer,
                    resolvedCount: resolvedValues.length,
                    resolvedTrue,
                    resolvedFalse,
                },
                [resolvedValues.buffer],
            );
            return;
        }

        const candidateMask = new Uint8Array(candidateMaskBuffer);
        if (!unknownIndices) {
            throw new Error('refineUnknownMask requires unknownIndicesBuffer');
        }
        const refined = refineUnknownMask(renderState, candidateMask, unknownIndices, options);

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
