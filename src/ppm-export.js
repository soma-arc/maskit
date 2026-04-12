export function buildPpmFromRgba(width, height, pixels) {
    const lines = ['P3', `${width} ${height}`, '255'];

    for (let y = height - 1; y >= 0; y -= 1) {
        const row = [];
        for (let x = 0; x < width; x += 1) {
            const index = (y * width + x) * 4;
            row.push(`${pixels[index]} ${pixels[index + 1]} ${pixels[index + 2]}`);
        }
        lines.push(row.join(' '));
    }

    return `${lines.join('\n')}\n`;
}

export function downloadPpm(ppm, filename) {
    const blob = new Blob([ppm], { type: 'image/x-portable-pixmap' });
    const link = document.createElement('a');
    const objectUrl = URL.createObjectURL(blob);
    link.href = objectUrl;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}
