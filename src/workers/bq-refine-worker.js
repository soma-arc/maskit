import { evaluateBqPixel, refineUnknownMask } from '../bq-cpu.mjs';

self.addEventListener('message', (event) => {
    const { requestId, renderState, candidateMaskBuffer, unknownPixels, options, action } =
        event.data;

    try {
        if (action === 'resolveUnknownPixels') {
            const resolvedValues = new Uint8Array(unknownPixels.length);
            let resolvedTrue = 0;
            let resolvedFalse = 0;

            for (let index = 0; index < unknownPixels.length; index += 1) {
                const nextValue = evaluateBqPixel(renderState, unknownPixels[index].index, options)
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
