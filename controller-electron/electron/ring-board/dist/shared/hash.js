export function serializeSceneMatrix(width, height, matrix) {
    const rows = [];
    for (let y = 0; y < height; y += 1) {
        const row = Array.isArray(matrix[y]) ? matrix[y] : [];
        rows.push(row.map((value) => String(Number(value) || 0)).join(","));
    }
    return `${width}:${height}:${rows.join("|")}`;
}
export function fnv1a32(input) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
export function computeSceneHash(width, height, matrix) {
    return fnv1a32(serializeSceneMatrix(width, height, matrix));
}
export function computeSceneHashFromSnapshot(scene) {
    return computeSceneHash(scene.width, scene.height, scene.matrix);
}
