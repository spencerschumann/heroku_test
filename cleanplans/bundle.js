// src/pdf/pdf_render.ts
async function loadPdfDocument(file, pdfjsLib2) {
  const copy = new Uint8Array(file);
  const loadingTask = pdfjsLib2.getDocument({ data: copy });
  const doc = await loadingTask.promise;
  return { numPages: doc.numPages, _doc: doc };
}
async function getPageSizes(doc) {
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc._doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    sizes.push({ widthPt: vp.width, heightPt: vp.height });
  }
  return sizes;
}
async function getPageLabels(doc) {
  try {
    const labels = await doc._doc.getPageLabels();
    if (labels && labels.length > 0) return labels;
  } catch {
  }
  return Array.from({ length: doc.numPages }, (_, i) => String(i + 1));
}
var TARGET_DPI = 200;
var SCALE_200DPI = TARGET_DPI / 72;
var CM_PER_INCH = 2.54;
function snapToCleanUnit(rawInches, dpi) {
  const snappedInch = Math.round(rawInches * 100) / 100;
  const pxResidualInch = Math.abs(snappedInch * dpi - Math.round(snappedInch * dpi));
  const rawCm = rawInches * CM_PER_INCH;
  const snappedCm = Math.round(rawCm * 100) / 100;
  const snappedCmAsInch = snappedCm / CM_PER_INCH;
  const pxResidualCm = Math.abs(snappedCmAsInch * dpi - Math.round(snappedCmAsInch * dpi));
  return pxResidualInch <= pxResidualCm ? snappedInch : snappedCmAsInch;
}
async function renderPdfPage(doc, pageNumber, backend, scale = SCALE_200DPI) {
  const page = await doc._doc.getPage(pageNumber);
  const baseViewport = page.getViewport({ scale: 1 });
  const rawWidthInches = baseViewport.width / 72;
  const rawHeightInches = baseViewport.height / 72;
  const dpi = scale * 72;
  const pageWidthInches = snapToCleanUnit(rawWidthInches, dpi);
  const pageHeightInches = snapToCleanUnit(rawHeightInches, dpi);
  const desiredW = Math.round(pageWidthInches * dpi);
  const desiredH = Math.round(pageHeightInches * dpi);
  const adjustedScaleX = desiredW / baseViewport.width;
  const adjustedScaleY = desiredH / baseViewport.height;
  const adjustedScale = (adjustedScaleX + adjustedScaleY) / 2;
  const viewport = page.getViewport({ scale: adjustedScale });
  console.log(
    `[pdf_render] page ${pageNumber}:
  PDF points:      ${baseViewport.width} \xD7 ${baseViewport.height}
  Raw inches:      ${rawWidthInches.toFixed(6)}\u2033 \xD7 ${rawHeightInches.toFixed(6)}\u2033
  Snapped inches:  ${pageWidthInches}\u2033 \xD7 ${pageHeightInches}\u2033
  Target DPI:      ${dpi}
  Desired pixels:  ${desiredW} \xD7 ${desiredH}
  Adjusted scale:  ${adjustedScale.toFixed(10)} (was ${scale.toFixed(10)})`
  );
  const canvas2 = backend.createCanvas(desiredW, desiredH);
  const context = canvas2.getContext("2d");
  if (!context) throw new Error("Failed to get 2d context");
  await page.render({ canvasContext: context, viewport }).promise;
  const imageData = context.getImageData(0, 0, canvas2.width, canvas2.height);
  return {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data,
    pageWidthInches,
    pageHeightInches
  };
}
async function renderPdfThumbnail(doc, pageNumber, backend, maxDimension = 200) {
  const page = await doc._doc.getPage(pageNumber);
  const viewport1 = page.getViewport({ scale: 1 });
  const scale = maxDimension / Math.max(viewport1.width, viewport1.height);
  const viewport = page.getViewport({ scale });
  const canvas2 = backend.createCanvas(
    Math.round(viewport.width),
    Math.floor(viewport.height)
  );
  const context = canvas2.getContext("2d");
  if (!context) throw new Error("Failed to get 2d context");
  await page.render({ canvasContext: context, viewport }).promise;
  const imageData = context.getImageData(0, 0, canvas2.width, canvas2.height);
  return {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data
  };
}

// src/gpu/software_adapter.ts
function isSoftwareAdapter(adapter) {
  if (!adapter) return false;
  const a = adapter;
  if (a.isFallbackAdapter === true) return true;
  const info = a.info ?? {};
  const s = [info.vendor, info.architecture, info.description, info.device].filter(Boolean).join(" ").toLowerCase();
  return SOFTWARE_RE.test(s);
}
var SOFTWARE_RE = /swiftshader|lavapipe|llvmpipe|softwarerasterizer|basic render|microsoft basic|warp/;
function describeAdapter(adapter) {
  if (!adapter) return "(no adapter)";
  const info = adapter.info ?? {};
  const s = [info.vendor, info.architecture, info.description, info.device].filter(Boolean).join(" ");
  return s || "(unknown adapter)";
}

// src/denoise/onnx_session.ts
var LOG = "[ONNX]";
async function detectGpuCapabilities() {
  console.log(`${LOG} Detecting GPU capabilities...`);
  const float16Array = typeof Float16Array !== "undefined";
  console.log(`${LOG}   Float16Array: ${float16Array ? "YES \u2713" : "no"}`);
  const gpu = navigator.gpu;
  if (!gpu) {
    console.log(`${LOG}   navigator.gpu not present \u2192 WASM fallback`);
    return { webgpu: false, shaderF16: false, float16Array };
  }
  console.log(`${LOG}   navigator.gpu present`);
  let adapter;
  try {
    adapter = await gpu.requestAdapter();
  } catch (err) {
    console.warn(`${LOG}   requestAdapter() threw:`, err);
    return { webgpu: false, shaderF16: false, float16Array };
  }
  if (!adapter) {
    console.warn(`${LOG}   requestAdapter() returned null \u2192 WASM fallback`);
    return { webgpu: false, shaderF16: false, float16Array };
  }
  const info = adapter.info ?? {};
  const adapterDesc = info.description ?? "(unknown adapter)";
  const shaderF16 = adapter.features.has("shader-f16");
  console.log(`${LOG}   Adapter: ${adapterDesc}`);
  console.log(`${LOG}   shader-f16 feature: ${shaderF16 ? "YES \u2713" : "no"}`);
  const features = [];
  adapter.features.forEach((f) => features.push(f));
  console.log(`${LOG}   All adapter features: [${features.sort().join(", ")}]`);
  const infoStr = [info.vendor, info.architecture, info.description, info.device].filter(Boolean).join(" ").toLowerCase();
  const isSoftware = isSoftwareAdapter(adapter);
  if (isSoftware) {
    console.log(
      `${LOG}   Adapter is a software rasteriser ("${infoStr.trim() || "unknown"}") \u2192 using WASM EP instead (much faster for this model; identical output)`
    );
    return { webgpu: false, shaderF16: false, float16Array };
  }
  return { webgpu: true, shaderF16, float16Array };
}
async function createOnnxSession(models) {
  if (typeof ort === "undefined") {
    throw new Error(
      "ONNX Runtime Web is not loaded. Ensure ort.min.js is included in index.html."
    );
  }
  const caps = await detectGpuCapabilities();
  let modelUrl;
  let executionProviders;
  let precision;
  let selectionReason;
  if (caps.webgpu && caps.shaderF16 && caps.float16Array) {
    modelUrl = models.f16;
    executionProviders = ["webgpu"];
    precision = "f16";
    selectionReason = "WebGPU + shader-f16 + Float16Array \u2192 f16 model (fastest)";
  } else if (caps.webgpu) {
    modelUrl = models.f32;
    executionProviders = ["webgpu"];
    precision = "f32";
    selectionReason = caps.shaderF16 ? "WebGPU + shader-f16 (no Float16Array) \u2192 f32 model" : "WebGPU (no shader-f16) \u2192 f32 model";
  } else {
    modelUrl = models.f32;
    executionProviders = ["wasm"];
    precision = "f32";
    selectionReason = "No usable WebGPU \u2192 WASM EP + f32 model (6x faster than int8 here)";
  }
  console.log(`${LOG} Selected: ${selectionReason}`);
  console.log(`${LOG} Model URL: ${modelUrl}`);
  console.log(`${LOG} Execution providers: [${executionProviders.join(", ")}]`);
  console.log(`${LOG} Creating session...`);
  const sessionOptions = { executionProviders };
  if (caps.webgpu) {
    sessionOptions.preferredOutputLocation = "gpu-buffer";
  }
  const t02 = performance.now();
  const session = await ort.InferenceSession.create(modelUrl, sessionOptions);
  const elapsed = (performance.now() - t02).toFixed(0);
  console.log(
    `${LOG} Session ready in ${elapsed} ms.  Inputs: [${session.inputNames}]  Outputs: [${session.outputNames}]`
  );
  const receptiveField = models.receptiveField;
  console.log(`${LOG} receptive_field=${receptiveField}`);
  return {
    precision,
    executionProvider: executionProviders[0],
    receptiveField,
    async run(inputName, data, dims) {
      const tensorType = data instanceof Float16Array ? "float16" : data instanceof Uint8Array ? "uint8" : "float32";
      const tensor = new ort.Tensor(tensorType, data, dims);
      const feeds = { [inputName]: tensor };
      const results = await session.run(feeds);
      const output = results[session.outputNames[0]];
      let rawData;
      if (output.location === "gpu-buffer") {
        rawData = await output.getData();
      } else {
        rawData = output.data;
      }
      output.dispose?.();
      tensor.dispose?.();
      return rawData;
    },
    dispose() {
      session.release();
    }
  };
}

// src/denoise/denoiser.ts
var DEFAULT_CONFIG = {
  tileSize: 512
};
var DEFAULT_RECEPTIVE_FIELD = 21;
var UINT8_TO_F32 = Float32Array.from(
  { length: 256 },
  (_, i) => i / 255
);
async function denoise(image, session, config = DEFAULT_CONFIG, onProgress) {
  const { width, height } = image;
  const rfPadding = Math.floor((session.receptiveField ?? DEFAULT_RECEPTIVE_FIELD) / 2);
  const { tileSize } = config;
  const precision = session.precision;
  if (width <= tileSize && height <= tileSize) {
    onProgress?.(0);
    const input = extractTile(image, 0, 0, width, height, precision);
    const output = await session.run("input", input, [1, 3, height, width]);
    onProgress?.(1);
    return { width, height, data: chwToRgba(output, width, height, 0, height) };
  }
  return tiledDenoise(image, session, tileSize, rfPadding, onProgress);
}
async function tiledDenoise(image, session, tileSize, rfPadding, onProgress) {
  const { width, height } = image;
  const precision = session.precision;
  const tilesX = Math.ceil(width / tileSize);
  const tilesY = Math.ceil(height / tileSize);
  const totalTiles = tilesX * tilesY;
  console.log(
    `[ONNX Tiled] Denoising ${width}\xD7${height} image with ${tilesX}\xD7${tilesY}=${totalTiles} tiles (${tileSize}px, padding=${rfPadding}px)`
  );
  const t02 = performance.now();
  const data = new Uint8ClampedArray(width * height * 4);
  let totalInferenceTime = 0;
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * tileSize;
      const y0 = ty * tileSize;
      const tileW = Math.min(tileSize, width - x0);
      const tileH = Math.min(tileSize, height - y0);
      const padX0 = Math.max(0, x0 - rfPadding);
      const padY0 = Math.max(0, y0 - rfPadding);
      const padX1 = Math.min(width, x0 + tileW + rfPadding);
      const padY1 = Math.min(height, y0 + tileH + rfPadding);
      const padW = padX1 - padX0;
      const padH = padY1 - padY0;
      const input = extractTile(image, padX0, padY0, padW, padH, precision);
      const inferenceT0 = performance.now();
      const output = await session.run("input", input, [1, 3, padH, padW]);
      totalInferenceTime += performance.now() - inferenceT0;
      blitTileToOutput(
        output,
        padW,
        padH,
        x0 - padX0,
        y0 - padY0,
        tileW,
        tileH,
        x0,
        y0,
        width,
        data
      );
      onProgress?.((ty * tilesX + tx + 1) / totalTiles);
    }
  }
  const totalTime = performance.now() - t02;
  console.log(
    `[ONNX Tiled] Inference: ${totalInferenceTime.toFixed(0)}ms (${(totalInferenceTime / totalTiles).toFixed(0)}ms avg/tile), total: ${totalTime.toFixed(0)}ms`
  );
  return { width, height, data };
}
function extractTile(image, x0, y0, tileW, tileH, precision) {
  const { width, data } = image;
  const planeSize = tileH * tileW;
  if (precision === "uint8") {
    const chw2 = new Uint8Array(3 * tileH * tileW);
    for (let y = 0; y < tileH; y++) {
      for (let x = 0; x < tileW; x++) {
        const srcIdx = ((y0 + y) * width + (x0 + x)) * 4;
        const dstIdx = y * tileW + x;
        chw2[dstIdx] = data[srcIdx];
        chw2[planeSize + dstIdx] = data[srcIdx + 1];
        chw2[2 * planeSize + dstIdx] = data[srcIdx + 2];
      }
    }
    return chw2;
  }
  const chw = precision === "f16" ? new Float16Array(3 * tileH * tileW) : new Float32Array(3 * tileH * tileW);
  for (let y = 0; y < tileH; y++) {
    for (let x = 0; x < tileW; x++) {
      const srcIdx = ((y0 + y) * width + (x0 + x)) * 4;
      const dstIdx = y * tileW + x;
      chw[dstIdx] = UINT8_TO_F32[data[srcIdx]];
      chw[planeSize + dstIdx] = UINT8_TO_F32[data[srcIdx + 1]];
      chw[2 * planeSize + dstIdx] = UINT8_TO_F32[data[srcIdx + 2]];
    }
  }
  return chw;
}
function chwToRgba(chw, width, paddedHeight, y0InPadded, stripHeight) {
  const planeSize = paddedHeight * width;
  const rgba = new Uint8ClampedArray(width * stripHeight * 4);
  if (chw instanceof Uint8Array) {
    for (let y = 0; y < stripHeight; y++) {
      const srcY = y0InPadded + y;
      for (let x = 0; x < width; x++) {
        const srcIdx = srcY * width + x;
        const dstIdx = (y * width + x) * 4;
        rgba[dstIdx] = chw[srcIdx];
        rgba[dstIdx + 1] = chw[planeSize + srcIdx];
        rgba[dstIdx + 2] = chw[2 * planeSize + srcIdx];
        rgba[dstIdx + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < stripHeight; y++) {
      const srcY = y0InPadded + y;
      for (let x = 0; x < width; x++) {
        const srcIdx = srcY * width + x;
        const dstIdx = (y * width + x) * 4;
        rgba[dstIdx] = Math.round(chw[srcIdx] * 255);
        rgba[dstIdx + 1] = Math.round(chw[planeSize + srcIdx] * 255);
        rgba[dstIdx + 2] = Math.round(chw[2 * planeSize + srcIdx] * 255);
        rgba[dstIdx + 3] = 255;
      }
    }
  }
  return rgba;
}
function blitTileToOutput(tileCHW, tileW, tileH, srcX0, srcY0, copyW, copyH, dstX0, dstY0, imageWidth, output) {
  const planeSize = tileH * tileW;
  if (tileCHW instanceof Uint8Array) {
    for (let y = 0; y < copyH; y++) {
      for (let x = 0; x < copyW; x++) {
        const srcIdx = (srcY0 + y) * tileW + (srcX0 + x);
        const dstIdx = ((dstY0 + y) * imageWidth + (dstX0 + x)) * 4;
        output[dstIdx] = tileCHW[srcIdx];
        output[dstIdx + 1] = tileCHW[planeSize + srcIdx];
        output[dstIdx + 2] = tileCHW[2 * planeSize + srcIdx];
        output[dstIdx + 3] = 255;
      }
    }
  } else {
    for (let y = 0; y < copyH; y++) {
      for (let x = 0; x < copyW; x++) {
        const srcIdx = (srcY0 + y) * tileW + (srcX0 + x);
        const dstIdx = ((dstY0 + y) * imageWidth + (dstX0 + x)) * 4;
        output[dstIdx] = Math.round(tileCHW[srcIdx] * 255);
        output[dstIdx + 1] = Math.round(tileCHW[planeSize + srcIdx] * 255);
        output[dstIdx + 2] = Math.round(tileCHW[2 * planeSize + srcIdx] * 255);
        output[dstIdx + 3] = 255;
      }
    }
  }
}

// src/color/palette.ts
var SCALE = 100;
var BIN_W = 1;
var GRID_DIM = 101;
var AB_OFFSET = 50;
function srgbToLinear(c) {
  const cn = c / 255;
  return cn <= 0.04045 ? cn / 12.92 : ((cn + 0.055) / 1.055) ** 2.4;
}
function linearToSrgb(c) {
  const v = c <= 31308e-7 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}
function srgbToOklab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2024326553 * lg + 0.6892648829 * lb);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  ];
}
function oklabToSrgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ];
}
function packKey(Lb, ab, bb) {
  return Lb * GRID_DIM * GRID_DIM + ab * GRID_DIM + bb;
}
function mergeVoxelGrids(grids) {
  const merged = /* @__PURE__ */ new Map();
  let totalChromatic = 0;
  for (const { voxels, totalChromatic: tc } of grids) {
    totalChromatic += tc;
    for (const [key, v] of voxels) {
      const existing = merged.get(key);
      if (existing) {
        existing.count += v.count;
      } else {
        merged.set(key, { Lb: v.Lb, ab: v.ab, bb: v.bb, count: v.count });
      }
    }
  }
  return { voxels: merged, totalChromatic };
}
function gaussianKernel(radius, sigma) {
  const size = 2 * radius + 1;
  const kernel = new Float64Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    const w = Math.exp(-(x * x) / (2 * sigma * sigma));
    kernel[i] = w;
    sum += w;
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  return kernel;
}
function smoothVoxelGrid(voxels, radiusL, sigmaL, radiusAB, sigmaAB) {
  const kernelL = gaussianKernel(radiusL, sigmaL);
  const kernelAB = gaussianKernel(radiusAB, sigmaAB);
  let current = /* @__PURE__ */ new Map();
  for (const [, v] of voxels) {
    for (let dL = -radiusL; dL <= radiusL; dL++) {
      const nL = v.Lb + dL;
      if (nL < 0 || nL >= GRID_DIM) continue;
      const key = packKey(nL, v.ab, v.bb);
      current.set(key, (current.get(key) ?? 0) + v.count * kernelL[dL + radiusL]);
    }
  }
  let next = /* @__PURE__ */ new Map();
  for (const [key, val] of current) {
    const Lb = Math.floor(key / (GRID_DIM * GRID_DIM));
    const rem = key - Lb * GRID_DIM * GRID_DIM;
    const ab = Math.floor(rem / GRID_DIM);
    const bb = rem - ab * GRID_DIM;
    for (let da = -radiusAB; da <= radiusAB; da++) {
      const na = ab + da;
      if (na < 0 || na >= GRID_DIM) continue;
      const nKey = packKey(Lb, na, bb);
      next.set(nKey, (next.get(nKey) ?? 0) + val * kernelAB[da + radiusAB]);
    }
  }
  current = next;
  next = /* @__PURE__ */ new Map();
  for (const [key, val] of current) {
    const Lb = Math.floor(key / (GRID_DIM * GRID_DIM));
    const rem = key - Lb * GRID_DIM * GRID_DIM;
    const ab = Math.floor(rem / GRID_DIM);
    const bb = rem - ab * GRID_DIM;
    for (let db2 = -radiusAB; db2 <= radiusAB; db2++) {
      const nb = bb + db2;
      if (nb < 0 || nb >= GRID_DIM) continue;
      const nKey = packKey(Lb, ab, nb);
      next.set(nKey, (next.get(nKey) ?? 0) + val * kernelAB[db2 + radiusAB]);
    }
  }
  return next;
}
function findLocalMaxima(smoothed) {
  const peaks = [];
  for (const [key, density] of smoothed) {
    if (density <= 0) continue;
    const Lb = Math.floor(key / (GRID_DIM * GRID_DIM));
    const rem = key - Lb * GRID_DIM * GRID_DIM;
    const ab = Math.floor(rem / GRID_DIM);
    const bb = rem - ab * GRID_DIM;
    let isMax = true;
    outer:
      for (let dL = -1; dL <= 1; dL++) {
        const nL = Lb + dL;
        if (nL < 0 || nL >= GRID_DIM) continue;
        for (let da = -1; da <= 1; da++) {
          const na = ab + da;
          if (na < 0 || na >= GRID_DIM) continue;
          for (let db2 = -1; db2 <= 1; db2++) {
            if (dL === 0 && da === 0 && db2 === 0) continue;
            const nb = bb + db2;
            if (nb < 0 || nb >= GRID_DIM) continue;
            const nDensity = smoothed.get(packKey(nL, na, nb)) ?? 0;
            if (nDensity >= density) {
              isMax = false;
              break outer;
            }
          }
        }
      }
    if (isMax) {
      peaks.push({ Lb, ab, bb, density });
    }
  }
  return peaks;
}
function assignVoxelsToPeaks(voxels, peaks) {
  const clusters = peaks.map(() => []);
  for (const [, v] of voxels) {
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < peaks.length; i++) {
      const p = peaks[i];
      const dL = v.Lb - p.Lb;
      const da = v.ab - p.ab;
      const db2 = v.bb - p.bb;
      const dist3 = dL * dL + da * da + db2 * db2;
      if (dist3 < bestDist) {
        bestDist = dist3;
        bestIdx = i;
      }
    }
    clusters[bestIdx].push(v);
  }
  return clusters;
}
function weightedMedian(items) {
  if (items.length === 0) return 0;
  if (items.length === 1) return items[0].value;
  items.sort((a, b) => a.value - b.value);
  let total = 0;
  for (const item of items) total += item.weight;
  const half = total / 2;
  let cum = 0;
  for (const item of items) {
    cum += item.weight;
    if (cum >= half) return item.value;
  }
  return items[items.length - 1].value;
}
function clusterMedianColor(voxels) {
  let count = 0;
  for (const v of voxels) count += v.count;
  const L = weightedMedian(
    voxels.map((v) => ({ value: (v.Lb + 0.5) * BIN_W, weight: v.count }))
  );
  const a = weightedMedian(
    voxels.map((v) => ({ value: (v.ab + 0.5) * BIN_W - AB_OFFSET, weight: v.count }))
  );
  const b = weightedMedian(
    voxels.map((v) => ({ value: (v.bb + 0.5) * BIN_W - AB_OFFSET, weight: v.count }))
  );
  return { L, a, b, count };
}
function scaledDeltaE(a, b) {
  const dL = a.L - b.L;
  const da = a.a - b.a;
  const db2 = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db2 * db2);
}
function consolidate(entries, threshold) {
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < entries.length && !merged; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        if (scaledDeltaE(entries[i].color, entries[j].color) < threshold) {
          entries[i].voxels = entries[i].voxels.concat(entries[j].voxels);
          entries[i].color = clusterMedianColor(entries[i].voxels);
          entries.splice(j, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return entries;
}
function extractPaletteFromVoxels(grid, options) {
  const smoothRadiusL = options?.smoothRadiusL ?? 6;
  const smoothRadiusAB = options?.smoothRadiusAB ?? 2;
  const smoothSigmaL = options?.smoothSigmaL ?? 5;
  const smoothSigmaAB = options?.smoothSigmaAB ?? 1.5;
  const minClusterFrac = options?.minClusterFraction ?? 5e-3;
  const mergeThresh = options?.mergeThreshold ?? 3;
  const { voxels, totalChromatic } = grid;
  if (totalChromatic === 0) return [];
  console.log(
    `[palette] ${totalChromatic} chromatic pixels, ${voxels.size} voxels`
  );
  const t02 = performance.now();
  const smoothed = smoothVoxelGrid(voxels, smoothRadiusL, smoothSigmaL, smoothRadiusAB, smoothSigmaAB);
  const t1 = performance.now();
  console.log(`[palette] smoothed to ${smoothed.size} voxels in ${(t1 - t02).toFixed(1)}ms (rL=${smoothRadiusL}, \u03C3L=${smoothSigmaL}, rAB=${smoothRadiusAB}, \u03C3ab=${smoothSigmaAB})`);
  const peaks = findLocalMaxima(smoothed);
  const t2 = performance.now();
  console.log(`[palette] found ${peaks.length} local maxima in ${(t2 - t1).toFixed(1)}ms`);
  if (peaks.length === 0) return [];
  const clusters = assignVoxelsToPeaks(voxels, peaks);
  const minClusterSize = Math.round(totalChromatic * minClusterFrac);
  let entries = [];
  for (const cluster of clusters) {
    if (cluster.length === 0) continue;
    const color = clusterMedianColor(cluster);
    if (color.count >= minClusterSize) {
      entries.push({ color, voxels: cluster });
    }
  }
  if (entries.length === 0) return [];
  console.log(`[palette] ${entries.length} clusters after size filter (min ${minClusterSize})`);
  entries = consolidate(entries, mergeThresh);
  console.log(`[palette] ${entries.length} entries after consolidation (thresh ${mergeThresh})`);
  entries.sort((a, b) => b.color.count - a.color.count);
  return entries.map((e) => {
    const rawL = e.color.L / SCALE;
    const rawA = e.color.a / SCALE;
    const rawB = e.color.b / SCALE;
    const [r, g, bRgb] = oklabToSrgb(rawL, rawA, rawB);
    return {
      oklab: [rawL, rawA, rawB],
      rgb: [r, g, bRgb],
      count: e.color.count,
      fraction: e.color.count / totalChromatic
    };
  });
}
function mergeBWCounts(counts) {
  let blackCount = 0, whiteCount = 0, totalPixels = 0;
  let bR = 0, bG = 0, bB = 0;
  let wR = 0, wG = 0, wB = 0;
  for (const c of counts) {
    blackCount += c.blackCount;
    whiteCount += c.whiteCount;
    totalPixels += c.totalPixels;
    bR += c.blackRgb[0] * c.blackCount;
    bG += c.blackRgb[1] * c.blackCount;
    bB += c.blackRgb[2] * c.blackCount;
    wR += c.whiteRgb[0] * c.whiteCount;
    wG += c.whiteRgb[1] * c.whiteCount;
    wB += c.whiteRgb[2] * c.whiteCount;
  }
  return {
    blackCount,
    blackRgb: blackCount > 0 ? [Math.round(bR / blackCount), Math.round(bG / blackCount), Math.round(bB / blackCount)] : [0, 0, 0],
    whiteCount,
    whiteRgb: whiteCount > 0 ? [Math.round(wR / whiteCount), Math.round(wG / whiteCount), Math.round(wB / whiteCount)] : [255, 255, 255],
    totalPixels
  };
}

// wgsl-raw:C:\Users\gauch\code\vectorizor\cleanplans-web\src\gpu\shaders\oklab_histogram.wgsl
var oklab_histogram_default = "// oklab_histogram.wgsl\r\n//\r\n// Converts every pixel of an RGBA image to OKLab, classifies it as\r\n// black / white / chromatic, and accumulates:\r\n//   - A dense 3D histogram in 101-bin OKLab space  (chromatic pixels)\r\n//   - Per-channel RGB sums for black and white pixels\r\n//\r\n// Bindings\r\n// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n//   0 \u2014 texture_2d<f32>  input image (rgba8unorm, values in [0, 1])\r\n//   1 \u2014 uniform Dims     { width, height }\r\n//   2 \u2014 storage r/w      histogram[101 * 101 * 101]  (atomic u32)\r\n//       index = Lb * 101 * 101 + ab * 101 + bb\r\n//       where Lb = floor(L*100), ab = floor(a*100+50), bb = floor(b*100+50)\r\n//   3 \u2014 storage r/w      bwStats[8]  (atomic u32)\r\n//       [0] blackCount\r\n//       [1] blackRsum_s  (r >> 3, i.e. 0-31, to avoid overflow on large images)\r\n//       [2] blackGsum_s\r\n//       [3] blackBsum_s\r\n//       [4] whiteCount\r\n//       [5] whiteRsum_s\r\n//       [6] whiteGsum_s\r\n//       [7] whiteBsum_s\r\n//\r\n// CPU side reconstructs the average as:\r\n//   blackRgb[0] = round(blackRsum_s * 8 / blackCount)\r\n// (max safe image: ~88 Mpx at 200 DPI on B0 paper \u2192 88M * 31 < u32 max)\r\n\r\nconst GRID_DIM: u32 = 101u;\r\nconst SCALE:    f32 = 100.0;\r\nconst AB_OFF:   f32 = 50.0;\r\n\r\n// Scaled-L thresholds that match palette.ts (L_BLACK_S = 5, L_WHITE_S = 95)\r\nconst L_BLACK_S: f32 = 5.0;\r\nconst L_WHITE_S: f32 = 95.0;\r\n\r\nstruct Dims {\r\n    width:  u32,\r\n    height: u32,\r\n    _pad0:  u32,\r\n    _pad1:  u32,\r\n}\r\n\r\n@group(0) @binding(0) var inputTex:  texture_2d<f32>;\r\n@group(0) @binding(1) var<uniform>              dims:      Dims;\r\n@group(0) @binding(2) var<storage, read_write>  histogram: array<atomic<u32>>;\r\n@group(0) @binding(3) var<storage, read_write>  bwStats:   array<atomic<u32>>;\r\n\r\n// ---------------------------------------------------------------------------\r\n// OKLab conversion  (identical coefficients to palette.ts / palette_decompose.wgsl)\r\n// ---------------------------------------------------------------------------\r\n\r\nfn srgb_to_linear(c: f32) -> f32 {\r\n    if (c <= 0.04045) { return c / 12.92; }\r\n    return pow((c + 0.055) / 1.055, 2.4);\r\n}\r\n\r\nfn rgb_to_oklab(rgb: vec3f) -> vec3f {\r\n    let r = srgb_to_linear(rgb.x);\r\n    let g = srgb_to_linear(rgb.y);\r\n    let b = srgb_to_linear(rgb.z);\r\n\r\n    let l_ = pow(max(0.0, 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), 1.0 / 3.0);\r\n    let m_ = pow(max(0.0, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), 1.0 / 3.0);\r\n    let s_ = pow(max(0.0, 0.0883024619 * r + 0.2024326553 * g + 0.6892648829 * b), 1.0 / 3.0);\r\n\r\n    return vec3f(\r\n         0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,\r\n         1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,\r\n         0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,\r\n    );\r\n}\r\n\r\n// ---------------------------------------------------------------------------\r\n// Main\r\n// ---------------------------------------------------------------------------\r\n\r\n@compute @workgroup_size(8, 8)\r\nfn main(@builtin(global_invocation_id) gid: vec3<u32>) {\r\n    let x = gid.x;\r\n    let y = gid.y;\r\n    if (x >= dims.width || y >= dims.height) { return; }\r\n\r\n    let color = textureLoad(inputTex, vec2i(i32(x), i32(y)), 0);\r\n    let lab   = rgb_to_oklab(color.xyz);\r\n    let Ls    = lab.x * SCALE;  // [0, 100]\r\n\r\n    // 5-bit shifted channel values (0\u201331) for overflow-safe RGB accumulation.\r\n    let r5 = u32(color.x * 255.0 + 0.5) >> 3u;\r\n    let g5 = u32(color.y * 255.0 + 0.5) >> 3u;\r\n    let b5 = u32(color.z * 255.0 + 0.5) >> 3u;\r\n\r\n    if (Ls < L_BLACK_S) {\r\n        atomicAdd(&bwStats[0], 1u);\r\n        atomicAdd(&bwStats[1], r5);\r\n        atomicAdd(&bwStats[2], g5);\r\n        atomicAdd(&bwStats[3], b5);\r\n        return;\r\n    }\r\n\r\n    if (Ls > L_WHITE_S) {\r\n        atomicAdd(&bwStats[4], 1u);\r\n        atomicAdd(&bwStats[5], r5);\r\n        atomicAdd(&bwStats[6], g5);\r\n        atomicAdd(&bwStats[7], b5);\r\n        return;\r\n    }\r\n\r\n    // Chromatic pixel \u2014 bin into the 3D histogram.\r\n    // floor() via u32() cast (safe: all inputs are >= 0 after clamping).\r\n    let Lb = min(GRID_DIM - 1u, u32(Ls));\r\n    let ab = min(GRID_DIM - 1u, u32(max(0.0, lab.y * SCALE + AB_OFF)));\r\n    let bb = min(GRID_DIM - 1u, u32(max(0.0, lab.z * SCALE + AB_OFF)));\r\n\r\n    let idx = Lb * GRID_DIM * GRID_DIM + ab * GRID_DIM + bb;\r\n    atomicAdd(&histogram[idx], 1u);\r\n}\r\n";

// src/gpu/oklab_histogram.ts
var GRID_DIM2 = 101;
var HIST_SIZE = GRID_DIM2 * GRID_DIM2 * GRID_DIM2;
var cachedPipeline = null;
function getOrCreatePipeline(device) {
  if (cachedPipeline && cachedPipeline.device !== device) {
    cachedPipeline = null;
  }
  if (cachedPipeline) return cachedPipeline;
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ]
  });
  const module = device.createShaderModule({ code: oklab_histogram_default });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    compute: { module, entryPoint: "main" }
  });
  cachedPipeline = { device, pipeline, bgl };
  return cachedPipeline;
}
async function buildVoxelGridGPU(device, image) {
  const { pipeline, bgl } = getOrCreatePipeline(device);
  const texture = device.createTexture({
    size: { width: image.width, height: image.height },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  device.queue.writeTexture(
    { texture },
    image.data,
    { bytesPerRow: image.width * 4 },
    { width: image.width, height: image.height }
  );
  const dimsData = new Uint32Array([image.width, image.height, 0, 0]);
  const dimsBuffer = device.createBuffer({
    size: dimsData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(dimsBuffer.getMappedRange()).set(dimsData);
  dimsBuffer.unmap();
  const histBuffer = device.createBuffer({
    size: HIST_SIZE * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const bwBuffer = device.createBuffer({
    size: 8 * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const histStaging = device.createBuffer({
    size: HIST_SIZE * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const bwStaging = device.createBuffer({
    size: 8 * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: { buffer: dimsBuffer } },
      { binding: 2, resource: { buffer: histBuffer } },
      { binding: 3, resource: { buffer: bwBuffer } }
    ]
  });
  const encoder = device.createCommandEncoder();
  encoder.clearBuffer(histBuffer);
  encoder.clearBuffer(bwBuffer);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(
    Math.ceil(image.width / 8),
    Math.ceil(image.height / 8)
  );
  pass.end();
  encoder.copyBufferToBuffer(histBuffer, 0, histStaging, 0, HIST_SIZE * 4);
  encoder.copyBufferToBuffer(bwBuffer, 0, bwStaging, 0, 8 * 4);
  device.queue.submit([encoder.finish()]);
  let histData;
  let bwData;
  try {
    await Promise.all([
      histStaging.mapAsync(GPUMapMode.READ),
      bwStaging.mapAsync(GPUMapMode.READ)
    ]);
    histData = new Uint32Array(histStaging.getMappedRange()).slice();
    bwData = new Uint32Array(bwStaging.getMappedRange()).slice();
    histStaging.unmap();
    bwStaging.unmap();
  } finally {
    texture.destroy();
    dimsBuffer.destroy();
    histBuffer.destroy();
    bwBuffer.destroy();
    histStaging.destroy();
    bwStaging.destroy();
  }
  const voxels = /* @__PURE__ */ new Map();
  let totalChromatic = 0;
  for (let Lb = 0; Lb < GRID_DIM2; Lb++) {
    for (let ab = 0; ab < GRID_DIM2; ab++) {
      for (let bb = 0; bb < GRID_DIM2; bb++) {
        const idx = Lb * GRID_DIM2 * GRID_DIM2 + ab * GRID_DIM2 + bb;
        const count = histData[idx];
        if (count > 0) {
          voxels.set(idx, { Lb, ab, bb, count });
          totalChromatic += count;
        }
      }
    }
  }
  const blackCount = bwData[0];
  const whiteCount = bwData[4];
  const bw = {
    blackCount,
    blackRgb: blackCount > 0 ? [
      Math.round(bwData[1] * 8 / blackCount),
      Math.round(bwData[2] * 8 / blackCount),
      Math.round(bwData[3] * 8 / blackCount)
    ] : [0, 0, 0],
    whiteCount,
    whiteRgb: whiteCount > 0 ? [
      Math.round(bwData[5] * 8 / whiteCount),
      Math.round(bwData[6] * 8 / whiteCount),
      Math.round(bwData[7] * 8 / whiteCount)
    ] : [255, 255, 255],
    totalPixels: blackCount + whiteCount + totalChromatic
  };
  return { grid: { voxels, totalChromatic }, bw };
}

// src/color/palette_editor.ts
var _nextId = 0;
function genId(prefix) {
  return `${prefix}-${_nextId++}`;
}
function rgbEqual(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
function createEditablePalette(entries, bw) {
  const inputs = [];
  const outputs = [];
  const blackIsBg = bw.blackCount >= bw.whiteCount;
  function addPair(rgb, oklab, count, fraction, role) {
    const inId = genId("in");
    const outId = genId("out");
    inputs.push({
      id: inId,
      oklab: [...oklab],
      rgb: [...rgb],
      count,
      fraction,
      enabled: true,
      role,
      outputId: outId
    });
    outputs.push({
      id: outId,
      rgb: [...rgb],
      oklab: [...oklab],
      isBackground: role === "background"
    });
  }
  if (bw.blackCount > 0) {
    const oklab = srgbToOklab(bw.blackRgb[0], bw.blackRgb[1], bw.blackRgb[2]);
    addPair(
      [...bw.blackRgb],
      oklab,
      bw.blackCount,
      bw.blackCount / bw.totalPixels,
      blackIsBg ? "background" : "stroke"
    );
  }
  if (bw.whiteCount > 0) {
    const oklab = srgbToOklab(bw.whiteRgb[0], bw.whiteRgb[1], bw.whiteRgb[2]);
    addPair(
      [...bw.whiteRgb],
      oklab,
      bw.whiteCount,
      bw.whiteCount / bw.totalPixels,
      blackIsBg ? "stroke" : "background"
    );
  }
  for (const e of entries) {
    addPair(
      [...e.rgb],
      [...e.oklab],
      e.count,
      e.count / bw.totalPixels,
      "chromatic"
    );
  }
  const roleOrder = { background: 0, stroke: 1, chromatic: 2 };
  inputs.sort((a, b) => {
    const ro = roleOrder[a.role] - roleOrder[b.role];
    if (ro !== 0) return ro;
    return b.count - a.count;
  });
  const outputOrder = new Map(inputs.map((inp, i) => [inp.outputId, i]));
  outputs.sort((a, b) => (outputOrder.get(a.id) ?? 999) - (outputOrder.get(b.id) ?? 999));
  return { inputs, outputs };
}
function addInput(palette, rgb) {
  const oklab = srgbToOklab(rgb[0], rgb[1], rgb[2]);
  const inId = genId("in");
  const outId = genId("out");
  const input = {
    id: inId,
    oklab,
    rgb: [...rgb],
    count: 0,
    fraction: 0,
    enabled: true,
    role: "chromatic",
    outputId: outId
  };
  const output = {
    id: outId,
    rgb: [...rgb],
    oklab: [...oklab],
    isBackground: false
  };
  return [{
    inputs: [...palette.inputs, input],
    outputs: [...palette.outputs, output]
  }, inId];
}
function removeInput(palette, inputId) {
  const removing = palette.inputs.find((i) => i.id === inputId);
  if (!removing) return palette;
  const newInputs = palette.inputs.filter((i) => i.id !== inputId);
  const outputStillUsed = newInputs.some((i) => i.outputId === removing.outputId);
  const newOutputs = outputStillUsed ? palette.outputs : palette.outputs.filter((o) => o.id !== removing.outputId);
  return { inputs: newInputs, outputs: newOutputs };
}
function assignInput(palette, inputId, outputId) {
  return {
    ...palette,
    inputs: palette.inputs.map(
      (inp) => inp.id === inputId ? { ...inp, outputId } : inp
    )
  };
}
function setOutputColor(palette, outputId, rgb) {
  const oklab = srgbToOklab(rgb[0], rgb[1], rgb[2]);
  return {
    ...palette,
    outputs: palette.outputs.map(
      (out) => out.id === outputId ? { ...out, rgb: [...rgb], oklab } : out
    )
  };
}
function setBackground(palette, outputId) {
  return {
    ...palette,
    outputs: palette.outputs.map((out) => ({
      ...out,
      isBackground: out.id === outputId
    }))
  };
}
function addOutput(palette, rgb) {
  const oklab = srgbToOklab(rgb[0], rgb[1], rgb[2]);
  const id = genId("out");
  const output = {
    id,
    rgb: [...rgb],
    oklab,
    isBackground: false
  };
  return [{ ...palette, outputs: [...palette.outputs, output] }, id];
}
function removeOutput(palette, outputId) {
  const removing = palette.outputs.find((o) => o.id === outputId);
  if (!removing || removing.isBackground) return palette;
  if (palette.outputs.length <= 1) return palette;
  const bgOutput = palette.outputs.find((o) => o.isBackground);
  const fallbackId = bgOutput?.id ?? palette.outputs[0].id;
  return {
    inputs: palette.inputs.map(
      (inp) => inp.outputId === outputId ? { ...inp, outputId: fallbackId } : inp
    ),
    outputs: palette.outputs.filter((o) => o.id !== outputId)
  };
}
function isRemapped(palette, inputId) {
  const inp = palette.inputs.find((i) => i.id === inputId);
  if (!inp) return false;
  const out = palette.outputs.find((o) => o.id === inp.outputId);
  if (!out) return false;
  return !rgbEqual(inp.rgb, out.rgb);
}

// wgsl-raw:C:\Users\gauch\code\vectorizor\cleanplans-web\src\gpu\shaders\palette_decompose.wgsl
var palette_decompose_default = "// Bindings:\r\n//   0 \u2014 texture_2d<f32>   input image  (rgba8unorm, values in [0,1])\r\n//   1 \u2014 uniform Dims       { width, height, rowStride, numColors }\r\n//   2 \u2014 storage read       array<u32>   palette packed as uint8\xD74 per entry:\r\n//                            bits  7:0  L  quantised [0,1]    \u2192 [0,255]\r\n//                            bits 15:8  a  quantised [-0.4,+0.4] \u2192 [0,255]\r\n//                            bits 23:16 b  quantised [-0.4,+0.4] \u2192 [0,255]\r\n//                            bits 31:24 layer index (0\u201331) or 255 = background\r\n//   3 \u2014 storage read_write array<u32>    output bit buffer (pre-cleared)\r\n\r\nconst MAX_COLORS: u32 = 32u;\r\n\r\nstruct Dims {\r\n    width:      u32,\r\n    height:     u32,\r\n    rowStride:  u32,\r\n    numPalette: u32,  // total entries in palette[] (incl. background/ignored)\r\n    numLayers:  u32,  // number of output bit-planes\r\n    _pad0: u32,\r\n    _pad1: u32,\r\n    _pad2: u32,\r\n}\r\n\r\n@group(0) @binding(0) var inputTex: texture_2d<f32>;\r\n@group(0) @binding(1) var<uniform> dims: Dims;\r\n@group(0) @binding(2) var<storage, read>       palette: array<u32>;\r\n@group(0) @binding(3) var<storage, read_write> output:  array<u32>;\r\n\r\n// Workgroup-shared bit accumulator \u2014 one u32 slot per possible palette layer.\r\nvar<workgroup> wg_bits: array<atomic<u32>, 32>;\r\n\r\n// ---------------------------------------------------------------------------\r\n// OKLab conversion  (sRGB [0,1] \u2192 OKLab)\r\n// ---------------------------------------------------------------------------\r\n\r\nfn srgb_to_linear(c: f32) -> f32 {\r\n    if (c <= 0.04045) { return c / 12.92; }\r\n    return pow((c + 0.055) / 1.055, 2.4);\r\n}\r\n\r\nfn rgb_to_oklab(rgb: vec3f) -> vec3f {\r\n    let r = srgb_to_linear(rgb.x);\r\n    let g = srgb_to_linear(rgb.y);\r\n    let b = srgb_to_linear(rgb.z);\r\n\r\n    let l_ = pow(max(0.0, 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), 1.0 / 3.0);\r\n    let m_ = pow(max(0.0, 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), 1.0 / 3.0);\r\n    let s_ = pow(max(0.0, 0.0883024619 * r + 0.2024326553 * g + 0.6892648829 * b), 1.0 / 3.0);\r\n\r\n    return vec3f(\r\n         0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,\r\n         1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,\r\n         0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,\r\n    );\r\n}\r\n\r\n// ---------------------------------------------------------------------------\r\n// Main\r\n// ---------------------------------------------------------------------------\r\n\r\n@compute @workgroup_size(32, 1)\r\nfn main(\r\n    @builtin(local_invocation_id)    lid:  vec3<u32>,\r\n    @builtin(local_invocation_index) lii:  u32,\r\n    @builtin(global_invocation_id)   gid:  vec3<u32>,\r\n    @builtin(workgroup_id)           wgid: vec3<u32>,\r\n) {\r\n    // \u2500\u2500 Step 1: zero the workgroup-shared bit accumulators \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n    if (lii < MAX_COLORS) {\r\n        atomicStore(&wg_bits[lii], 0u);\r\n    }\r\n    workgroupBarrier();\r\n\r\n    // \u2500\u2500 Step 2: each thread finds its layer and sets its bit \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n    let x = gid.x;\r\n    let y = gid.y;\r\n\r\n    if (x < dims.width && y < dims.height) {\r\n        let color = textureLoad(inputTex, vec2i(i32(x), i32(y)), 0);\r\n        let lab   = rgb_to_oklab(color.xyz);\r\n\r\n        // Nearest-neighbour match against palette.\r\n        // Each palette entry is one u32 with 4 packed uint8 fields:\r\n        //   bits  7:0  \u2014 L  quantised, maps [0,1]       via /255.0\r\n        //   bits 15:8  \u2014 a  quantised, maps [-0.4,+0.4] via /255.0*0.8-0.4\r\n        //   bits 23:16 \u2014 b  quantised, maps [-0.4,+0.4] via /255.0*0.8-0.4\r\n        //   bits 31:24 \u2014 layer index (0\u201331) or 255 = background/ignore\r\n        var bestDist = 1e9f;\r\n        var bestIdx  = 0u;\r\n        for (var i = 0u; i < dims.numPalette; i++) {\r\n            let packed = palette[i];\r\n            let pL = f32( packed        & 0xFFu) / 255.0;\r\n            let pA = f32((packed >> 8u) & 0xFFu) / 255.0 * 0.8 - 0.4;\r\n            let pB = f32((packed >>16u) & 0xFFu) / 255.0 * 0.8 - 0.4;\r\n            let p  = vec3f(pL, pA, pB);\r\n            let d  = dot(lab - p, lab - p);\r\n            if (d < bestDist) {\r\n                bestDist = d;\r\n                bestIdx  = i;\r\n            }\r\n        }\r\n\r\n        // bits 31:24 = layer index (0\u201331) or 255 = background/ignore\r\n        let layerSlot = (palette[bestIdx] >> 24u) & 0xFFu;\r\n        if (layerSlot != 255u) {\r\n            atomicOr(&wg_bits[layerSlot], 1u << lid.x);\r\n        }\r\n    }\r\n    workgroupBarrier();\r\n\r\n    // \u2500\u2500 Step 3: thread lii writes layer lii's accumulated word to global buf \u2500\r\n    //   All threads in this workgroup share the same y (workgroup_size y = 1)\r\n    //   and the same word-column index = wgid.x.\r\n    if (lii < dims.numLayers) {\r\n        let wi: u32       = y * dims.rowStride + wgid.x;\r\n        let layerBase: u32 = lii * dims.rowStride * dims.height;\r\n        output[layerBase + wi] = atomicLoad(&wg_bits[lii]);\r\n    }\r\n}\r\n";

// src/gpu/palette_decompose.ts
var MAX_COLORS = 32;
var cachedPipeline2 = null;
function getOrCreatePipeline2(device) {
  if (cachedPipeline2 && cachedPipeline2.device !== device) {
    cachedPipeline2 = null;
  }
  if (cachedPipeline2) return cachedPipeline2;
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ]
  });
  const module = device.createShaderModule({ code: palette_decompose_default });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    compute: { module, entryPoint: "main" }
  });
  cachedPipeline2 = { device, pipeline, bgl };
  return cachedPipeline2;
}
async function decomposePalette(device, image, palette) {
  const { pipeline, bgl } = getOrCreatePipeline2(device);
  let layerCount = 0;
  const layerIndexOf = /* @__PURE__ */ new Map();
  for (const inp of palette.inputs) {
    if (!inp.enabled) continue;
    const out = palette.outputs.find((o) => o.id === inp.outputId);
    if (out && !out.isBackground) layerIndexOf.set(inp.id, layerCount++);
  }
  const allInputs = palette.inputs.filter((inp) => palette.outputs.some((o) => o.id === inp.outputId)).sort((a, b) => {
    const pa = layerIndexOf.has(a.id) ? 0 : a.enabled ? 1 : 2;
    const pb = layerIndexOf.has(b.id) ? 0 : b.enabled ? 1 : 2;
    return pa - pb;
  });
  const eligibleInputs = palette.inputs.filter((inp) => layerIndexOf.has(inp.id));
  if (layerCount === 0 || layerCount > MAX_COLORS) {
    const buffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    return {
      width: image.width,
      height: image.height,
      rowStride: 0,
      layers: [],
      buffer,
      destroy() {
        buffer.destroy();
      }
    };
  }
  const numPalette = Math.min(allInputs.length, MAX_COLORS);
  const numLayers = layerCount;
  const rowStride = Math.ceil(image.width / 32);
  const layerWords = rowStride * image.height;
  const totalWords = numLayers * layerWords;
  const texture = device.createTexture({
    size: { width: image.width, height: image.height },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  device.queue.writeTexture(
    { texture },
    image.data,
    { bytesPerRow: image.width * 4 },
    { width: image.width, height: image.height }
  );
  const dimsData = new Uint32Array([image.width, image.height, rowStride, numPalette, numLayers, 0, 0, 0]);
  const dimsBuffer = device.createBuffer({
    size: dimsData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(dimsBuffer.getMappedRange()).set(dimsData);
  dimsBuffer.unmap();
  const AB_RANGE2 = 0.4;
  const paletteData = new Uint32Array(numPalette);
  for (let i = 0; i < numPalette; i++) {
    const inp = allInputs[i];
    const [L, a, b] = inp.oklab;
    const lQ = Math.max(0, Math.min(255, Math.round(L * 255)));
    const aQ = Math.max(0, Math.min(255, Math.round((a + AB_RANGE2) / (2 * AB_RANGE2) * 255)));
    const bQ = Math.max(0, Math.min(255, Math.round((b + AB_RANGE2) / (2 * AB_RANGE2) * 255)));
    const li = layerIndexOf.get(inp.id);
    const lay = li !== void 0 ? li : 255;
    paletteData[i] = lQ | aQ << 8 | bQ << 16 | lay << 24;
  }
  const paletteBuffer = device.createBuffer({
    size: paletteData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(paletteBuffer.getMappedRange()).set(paletteData);
  paletteBuffer.unmap();
  const outputBuffer = device.createBuffer({
    size: totalWords * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: { buffer: dimsBuffer } },
      { binding: 2, resource: { buffer: paletteBuffer } },
      { binding: 3, resource: { buffer: outputBuffer } }
    ]
  });
  const encoder = device.createCommandEncoder();
  encoder.clearBuffer(outputBuffer);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(
    Math.ceil(image.width / 32),
    // one workgroup per u32-column
    image.height,
    // one workgroup per row
    1
  );
  pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  texture.destroy();
  dimsBuffer.destroy();
  paletteBuffer.destroy();
  const layers = eligibleInputs.map((inp) => {
    const out = palette.outputs.find((o) => o.id === inp.outputId);
    return {
      inputId: inp.id,
      rgb: [...inp.rgb],
      outputRgb: [...out.rgb]
    };
  });
  return {
    width: image.width,
    height: image.height,
    rowStride,
    layers,
    buffer: outputBuffer,
    destroy() {
      outputBuffer.destroy();
    }
  };
}
async function readAllLayersAsRGBA(device, decomp) {
  const { width, height, rowStride, layers, buffer } = decomp;
  const numLayers = layers.length;
  const layerWords = rowStride * height;
  const layerBytes = layerWords * 4;
  const totalBytes = numLayers * layerBytes;
  const staging = device.createBuffer({
    size: totalBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, staging, 0, totalBytes);
  device.queue.submit([encoder.finish()]);
  const rgba = new Uint8ClampedArray(width * height * 4).fill(255);
  try {
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange());
    for (let i = 0; i < numLayers; i++) {
      const [r, g, b] = layers[i].outputRgb;
      const layerWordOffset = i * layerWords;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const wordIdx = layerWordOffset + y * rowStride + (x >>> 5);
          const bit = words[wordIdx] >>> (x & 31) & 1;
          if (bit) {
            const px = (y * width + x) * 4;
            rgba[px] = r;
            rgba[px + 1] = g;
            rgba[px + 2] = b;
            rgba[px + 3] = 255;
          }
        }
      }
    }
    staging.unmap();
  } finally {
    staging.destroy();
  }
  return { width, height, data: rgba };
}

// wgsl-raw:C:\Users\gauch\code\vectorizor\cleanplans-web\src\gpu\shaders\palette_cleanup.wgsl
var palette_cleanup_default = `// Palette cleanup: speckle removal and fringe absorption.\r
//\r
// Operates on the 1-bpp bit-plane buffer produced by palette_decompose.\r
//\r
// For each coloured pixel, the shader inspects a 7\xD77 neighbourhood and\r
// applies the following rules:\r
//\r
//   Inner window  = 5\xD75 (\xB12 pixels)\r
//   Outer ring    = 7\xD77 minus 5\xD75 (distance 3 in x or y)\r
//\r
//   myCount   = same-layer votes in the inner 5\xD75 window (incl. self)\r
//   hasOuter  = any same-layer pixel exists in the outer ring\r
//   bestCount = highest vote of any *other* layer in the inner window\r
//   bestLayer = which other layer achieved bestCount\r
//\r
// Isolation: a pixel is considered "isolated" when ANY of the following hold:\r
//\r
//   A. smallBlob \u2014 all same-layer pixels in the inner window fit within a 2\xD72\r
//      bounding box AND no same-layer pixel exists in the outer ring.\r
//      Catches compact stipple blobs (including 2-pixel diagonals) without\r
//      relying on the bridge heuristic (which can be fooled when the bridge\r
//      point lands on another pixel in the same blob).\r
//\r
//   B. !hasBridgedOuter AND myCount \u2264 6 AND !isSandwiched \u2014 classic\r
//      isolation: small cluster with no confirmed line continuation.\r
//      hasBridgedOuter requires the immediate sign-direction neighbour to\r
//      also be same-layer, so a 1-px gap between a stipple and a dash breaks\r
//      the bridge.  isSandwiched (active only when myCount \u2265 4) protects\r
//      dash interiors that have no outer continuation.\r
//\r
// Decision rules (in priority order):\r
//   isolated  AND bestCount \u2265 8         \u2192 reassign to dominant neighbour\r
//   isolated  AND bestCount < 8         \u2192 erase  (stipple / isolated artefact)\r
//   bestCount \u2265 8 AND 2\xB7bestCount \u2265 3\xB7myCount\r
//                                       \u2192 reassign  (dominant-neighbour fringe;\r
//                                          covers both thin 1-3 px fringes and\r
//                                          wider edge bands like red along orange)\r
//   otherwise                           \u2192 keep\r
//\r
// Background hole filling (symmetric to foreground speck removal):\r
//   Detects 1-pixel holes (all 4 ortho neighbours are foreground) and 2-pixel\r
//   holes (exactly 1 background ortho neighbour Q, whose own 3 non-P ortho\r
//   neighbours are all foreground).  Both patterns have no 4-connected path to\r
//   the exterior background and would create spurious skeleton loops under\r
//   Guo-Hall thinning.  Out-of-bounds neighbours count as background so that\r
//   border pixels are never filled.\r
//\r
// Buffer layout (same as palette_decompose output):\r
//   [layer 0 : rowStride \xD7 height \xD7 u32]\r
//   \u2026\r
//   rowStride = ceil(width / 32)\r
//\r
// Workgroup: 32 \xD7 1 \u2014 one workgroup per 32-pixel-wide row segment.\r
\r
const MAX_LAYERS: u32 = 32u;\r
\r
struct Dims {\r
    width:      u32,\r
    height:     u32,\r
    rowStride:  u32,\r
    numLayers:  u32,\r
    _pad0:      u32,\r
    _pad1:      u32,\r
    _pad2:      u32,\r
    _pad3:      u32,\r
}\r
\r
@group(0) @binding(0) var<uniform>             dims: Dims;\r
@group(0) @binding(1) var<storage, read>       src:  array<u32>;\r
@group(0) @binding(2) var<storage, read_write> dst:  array<u32>;\r
\r
var<workgroup> wg_bits: array<atomic<u32>, MAX_LAYERS>;\r
\r
// ---------------------------------------------------------------------------\r
\r
fn getSrcLayer(px: u32, py: u32) -> u32 {\r
    let wordCol = px >> 5u;\r
    let bit     = px & 31u;\r
    let rowWord = py * dims.rowStride + wordCol;\r
    for (var l = 0u; l < dims.numLayers; l++) {\r
        let word = src[l * dims.rowStride * dims.height + rowWord];\r
        if ((word >> bit) & 1u) != 0u {\r
            return l;\r
        }\r
    }\r
    return 255u;\r
}\r
\r
// ---------------------------------------------------------------------------\r
\r
@compute @workgroup_size(32, 1)\r
fn main(\r
    @builtin(local_invocation_id)    lid:  vec3<u32>,\r
    @builtin(local_invocation_index) lii:  u32,\r
    @builtin(workgroup_id)           wgid: vec3<u32>,\r
) {\r
    if (lii < MAX_LAYERS) {\r
        atomicStore(&wg_bits[lii], 0u);\r
    }\r
    workgroupBarrier();\r
\r
    let px = wgid.x * 32u + lid.x;\r
    let py = wgid.y;\r
\r
    if (px < dims.width && py < dims.height) {\r
        let myLayer = getSrcLayer(px, py);\r
\r
        if (myLayer < dims.numLayers) {\r
            // \u2500\u2500 Vote in the 7\xD77 window \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r
            var votes: array<u32, MAX_LAYERS>;\r
            var hasBridgedOuter = false;\r
            var hasOuter        = false;\r
            // Bounding box of same-layer pixels in the inner window (for smallBlob).\r
            var bboxMinX = i32(px);\r
            var bboxMaxX = i32(px);\r
            var bboxMinY = i32(py);\r
            var bboxMaxY = i32(py);\r
\r
            for (var dy: i32 = -3; dy <= 3; dy++) {\r
                for (var dx: i32 = -3; dx <= 3; dx++) {\r
                    let nx = i32(px) + dx;\r
                    let ny = i32(py) + dy;\r
                    if (nx >= 0 && ny >= 0 &&\r
                        u32(nx) < dims.width && u32(ny) < dims.height) {\r
                        let l = getSrcLayer(u32(nx), u32(ny));\r
                        if (l < dims.numLayers) {\r
                            let inner = (dx >= -2 && dx <= 2 && dy >= -2 && dy <= 2);\r
                            if (inner) {\r
                                votes[l]++;\r
                                if (l == myLayer) {\r
                                    bboxMinX = min(bboxMinX, nx);\r
                                    bboxMaxX = max(bboxMaxX, nx);\r
                                    bboxMinY = min(bboxMinY, ny);\r
                                    bboxMaxY = max(bboxMaxY, ny);\r
                                }\r
                            } else if (l == myLayer) {\r
                                hasOuter = true;\r
                                // Two-hop bridge: BOTH the immediate neighbour AND\r
                                // its next-step neighbour in the outer-pixel direction\r
                                // must be same-layer.  A single-hop bridge is fooled\r
                                // by a multi-pixel blob: one blob pixel provides hop 1\r
                                // while the outer dash provides the context, leaving a\r
                                // 1-pixel gap at hop 2 that correctly breaks the bridge.\r
                                let bx = clamp(dx, -1, 1);\r
                                let by = clamp(dy, -1, 1);\r
                                let nb1x = i32(px) + bx;\r
                                let nb1y = i32(py) + by;\r
                                let nb2x = i32(px) + 2 * bx;\r
                                let nb2y = i32(py) + 2 * by;\r
                                if (nb1x >= 0 && nb1y >= 0 &&\r
                                    u32(nb1x) < dims.width && u32(nb1y) < dims.height &&\r
                                    nb2x >= 0 && nb2y >= 0 &&\r
                                    u32(nb2x) < dims.width && u32(nb2y) < dims.height) {\r
                                    if (getSrcLayer(u32(nb1x), u32(nb1y)) == myLayer &&\r
                                        getSrcLayer(u32(nb2x), u32(nb2y)) == myLayer) {\r
                                        hasBridgedOuter = true;\r
                                    }\r
                                }\r
                            }\r
                        }\r
                    }\r
                }\r
            }\r
\r
            let myCount = votes[myLayer];\r
\r
            // smallBlob: all same-layer pixels in the inner window fit in a 2\xD72\r
            // bounding box AND no same-layer pixel exists in the outer ring.\r
            // This catches compact stipples (including diagonal pairs) without\r
            // needing the bridge heuristic.\r
            let bboxW = bboxMaxX - bboxMinX;\r
            let bboxH = bboxMaxY - bboxMinY;\r
            let fitsIn2x2 = (bboxW <= 1) && (bboxH <= 1);\r
            let smallBlob = (!hasOuter) && fitsIn2x2;\r
\r
            // blobSmall2D: cluster has extent in BOTH dimensions (2D, not a line)\r
            // and fits within a 4\xD74 bbox, with no outer-ring same-layer pixel.\r
            // Catches blobs (4\xD72, 3\xD73, etc.) whose edge pixels falsely self-bridge\r
            // through the blob's own interior \u2014 the 2-hop path stays inside the\r
            // blob, so hasBridgedOuter is spuriously true even though there is no\r
            // real line continuation.  Pure 1D runs (bboxH=0 or bboxW=0) are\r
            // excluded so that short dashes still use count+isSandwiched rules.\r
            let blobSmall2D = (!hasOuter) && (bboxW >= 1) && (bboxH >= 1)\r
                           && (bboxW <= 3) && (bboxH <= 3);\r
\r
            // isSandwiched: same-layer on both sides in any direction.\r
            // Guard: myCount >= 4 prevents a 3-pixel run's centre from being\r
            // protected (it would survive as a 1-pixel relic otherwise).\r
            let ipx = i32(px);\r
            let ipy = i32(py);\r
            let iw  = i32(dims.width);\r
            let ih  = i32(dims.height);\r
            var isSandwiched = false;\r
            if (myCount >= 4u) {\r
                // Horizontal\r
                if (!isSandwiched && ipx > 0 && ipx < iw - 1) {\r
                    if (getSrcLayer(u32(ipx - 1), py) == myLayer &&\r
                        getSrcLayer(u32(ipx + 1), py) == myLayer) {\r
                        isSandwiched = true;\r
                    }\r
                }\r
                // Vertical\r
                if (!isSandwiched && ipy > 0 && ipy < ih - 1) {\r
                    if (getSrcLayer(px, u32(ipy - 1)) == myLayer &&\r
                        getSrcLayer(px, u32(ipy + 1)) == myLayer) {\r
                        isSandwiched = true;\r
                    }\r
                }\r
                // NW-SE diagonal\r
                if (!isSandwiched && ipx > 0 && ipy > 0 && ipx < iw - 1 && ipy < ih - 1) {\r
                    if (getSrcLayer(u32(ipx - 1), u32(ipy - 1)) == myLayer &&\r
                        getSrcLayer(u32(ipx + 1), u32(ipy + 1)) == myLayer) {\r
                        isSandwiched = true;\r
                    }\r
                }\r
                // NE-SW diagonal\r
                if (!isSandwiched && ipx > 0 && ipy > 0 && ipx < iw - 1 && ipy < ih - 1) {\r
                    if (getSrcLayer(u32(ipx + 1), u32(ipy - 1)) == myLayer &&\r
                        getSrcLayer(u32(ipx - 1), u32(ipy + 1)) == myLayer) {\r
                        isSandwiched = true;\r
                    }\r
                }\r
            }\r
\r
            // Best competing (other-layer) count in the inner window.\r
            var bestLayer = 255u;\r
            var bestCount = 0u;\r
            for (var l = 0u; l < dims.numLayers; l++) {\r
                if (l != myLayer && votes[l] > bestCount) {\r
                    bestCount = votes[l];\r
                    bestLayer = l;\r
                }\r
            }\r
\r
            // \u2500\u2500 Apply rules \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r
            // A pixel is isolated when it has no confirmed outer continuation and\r
            // is not sandwiched between same-layer pixels.\r
            // Note: the former myCount \u2264 6 guard is removed.  It was meant to\r
            // protect medium-length features, but inflated myCount from a nearby\r
            // dash (which lands inside the \xB12 inner window) wrongly shielded\r
            // stipple blobs.  isSandwiched guards all legitimate line interiors;\r
            // hasBridgedOuter guards endpoints and edges with real continuation.\r
            let isolated = smallBlob || blobSmall2D ||\r
                           ((!hasBridgedOuter) && (!isSandwiched));\r
\r
            // Relative dominance: other layer is at least 1.5\xD7 as common.\r
            let dominates = (bestCount >= 8u) && (bestCount * 2u >= myCount * 3u);\r
\r
            var outLayer = myLayer;\r
            if (isolated) {\r
                if (bestCount >= 8u) {\r
                    outLayer = bestLayer;   // fringe blob abutting a bulk colour\r
                } else {\r
                    outLayer = 255u;        // erase: stipple / isolated artefact\r
                }\r
            } else if (dominates) {\r
                outLayer = bestLayer;       // fringe dominated by a neighbour layer\r
            }\r
\r
            if (outLayer < dims.numLayers) {\r
                atomicOr(&wg_bits[outLayer], 1u << lid.x);\r
            }\r
        }\r
        // Background hole filling.\r
        //\r
        // Under Guo-Hall thinning (8-connected foreground, 4-connected background)\r
        // a background pixel with no 4-connected path to the exterior cannot reach\r
        // the outside background \u2014 it is a topological hole that forces the skeleton\r
        // to loop.  We detect:\r
        //\r
        //   1-pixel hole: all 4 orthogonal neighbours are foreground.\r
        //   2-pixel hole: exactly 1 background ortho neighbour Q, and Q's own\r
        //                 3 non-P ortho neighbours are all foreground.\r
        //\r
        // Out-of-bounds neighbours count as background \u2192 border pixels are safe.\r
\r
        let ipx2 = i32(px);\r
        let ipy2 = i32(py);\r
        let iw2  = i32(dims.width);\r
        let ih2  = i32(dims.height);\r
\r
        var fv: array<u32, MAX_LAYERS>;   // foreground vote accumulator\r
\r
        // Fetch orthogonal neighbour layers (255 = background or OOB).\r
        var lN = 255u;\r
        if (ipy2 > 0)      { lN = getSrcLayer(px, u32(ipy2 - 1)); if (lN < dims.numLayers) { fv[lN]++; } }\r
        var lS = 255u;\r
        if (ipy2 < ih2-1)  { lS = getSrcLayer(px, u32(ipy2 + 1)); if (lS < dims.numLayers) { fv[lS]++; } }\r
        var lW = 255u;\r
        if (ipx2 > 0)      { lW = getSrcLayer(u32(ipx2 - 1), py); if (lW < dims.numLayers) { fv[lW]++; } }\r
        var lE = 255u;\r
        if (ipx2 < iw2-1)  { lE = getSrcLayer(u32(ipx2 + 1), py); if (lE < dims.numLayers) { fv[lE]++; } }\r
\r
        let bgN = u32(lN >= dims.numLayers);\r
        let bgS = u32(lS >= dims.numLayers);\r
        let bgW = u32(lW >= dims.numLayers);\r
        let bgE = u32(lE >= dims.numLayers);\r
        let nBg = bgN + bgS + bgW + bgE;\r
\r
        var shouldFill = false;\r
\r
        if (nBg == 0u) {\r
            // 1-pixel hole: all four ortho neighbours are foreground.\r
            shouldFill = true;\r
        } else if (nBg == 1u) {\r
            // Candidate 2-pixel hole.  Locate the partner pixel Q (the one\r
            // background ortho neighbour) and verify that Q's own 3 non-P\r
            // ortho neighbours are all foreground.\r
            var qx = ipx2; var qy = ipy2;\r
            // skipQ*: which of Q's four ortho directions points back to P.\r
            var skipQN = false; var skipQS = false;\r
            var skipQW = false; var skipQE = false;\r
            if      (bgN != 0u) { qy = ipy2 - 1; skipQS = true; }\r
            else if (bgS != 0u) { qy = ipy2 + 1; skipQN = true; }\r
            else if (bgW != 0u) { qx = ipx2 - 1; skipQE = true; }\r
            else                { qx = ipx2 + 1; skipQW = true; }\r
\r
            if (qx >= 0 && qy >= 0 && qx < iw2 && qy < ih2) {\r
                var qOk = true;\r
                // Q's North\r
                if (qOk && !skipQN) {\r
                    let qny = qy - 1;\r
                    if (qny < 0) { qOk = false; }\r
                    else { let ql = getSrcLayer(u32(qx), u32(qny)); if (ql >= dims.numLayers) { qOk = false; } else { fv[ql]++; } }\r
                }\r
                // Q's South\r
                if (qOk && !skipQS) {\r
                    let qsy = qy + 1;\r
                    if (qsy >= ih2) { qOk = false; }\r
                    else { let ql = getSrcLayer(u32(qx), u32(qsy)); if (ql >= dims.numLayers) { qOk = false; } else { fv[ql]++; } }\r
                }\r
                // Q's West\r
                if (qOk && !skipQW) {\r
                    let qwx = qx - 1;\r
                    if (qwx < 0) { qOk = false; }\r
                    else { let ql = getSrcLayer(u32(qwx), u32(qy)); if (ql >= dims.numLayers) { qOk = false; } else { fv[ql]++; } }\r
                }\r
                // Q's East\r
                if (qOk && !skipQE) {\r
                    let qex = qx + 1;\r
                    if (qex >= iw2) { qOk = false; }\r
                    else { let ql = getSrcLayer(u32(qex), u32(qy)); if (ql >= dims.numLayers) { qOk = false; } else { fv[ql]++; } }\r
                }\r
                if (qOk) { shouldFill = true; }\r
            }\r
        }\r
\r
        if (shouldFill) {\r
            var bestFill = 0u;\r
            for (var lo = 1u; lo < dims.numLayers; lo++) {\r
                if (fv[lo] > fv[bestFill]) { bestFill = lo; }\r
            }\r
            atomicOr(&wg_bits[bestFill], 1u << lid.x);\r
        }\r
    }\r
\r
    workgroupBarrier();\r
\r
    if (lii < dims.numLayers) {\r
        let wi        = py * dims.rowStride + wgid.x;\r
        let layerBase = lii * dims.rowStride * dims.height;\r
        dst[layerBase + wi] = atomicLoad(&wg_bits[lii]);\r
    }\r
}\r
`;

// src/gpu/palette_cleanup.ts
var cachedPipeline3 = null;
function getOrCreatePipeline3(device) {
  if (cachedPipeline3 && cachedPipeline3.device === device) return cachedPipeline3;
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ]
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    compute: {
      module: device.createShaderModule({ code: palette_cleanup_default }),
      entryPoint: "main"
    }
  });
  cachedPipeline3 = { device, pipeline, bgl };
  return cachedPipeline3;
}
async function cleanupPalette(device, decomp) {
  const { pipeline, bgl } = getOrCreatePipeline3(device);
  const { width, height, rowStride, layers } = decomp;
  const numLayers = layers.length;
  const layerWords = rowStride * height;
  const totalWords = numLayers * layerWords;
  if (numLayers === 0) {
    const buf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    return { width, height, rowStride, layers, buffer: buf, destroy() {
      buf.destroy();
    } };
  }
  const dimsData = new Uint32Array([width, height, rowStride, numLayers, 0, 0, 0, 0]);
  const dimsBuffer = device.createBuffer({
    size: dimsData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(dimsBuffer.getMappedRange()).set(dimsData);
  dimsBuffer.unmap();
  const dstBuffer = device.createBuffer({
    size: totalWords * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: dimsBuffer } },
      { binding: 1, resource: { buffer: decomp.buffer } },
      { binding: 2, resource: { buffer: dstBuffer } }
    ]
  });
  const encoder = device.createCommandEncoder();
  encoder.clearBuffer(dstBuffer);
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(
    Math.ceil(width / 32),
    // one workgroup per u32-column
    height,
    // one workgroup per row
    1
  );
  pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  dimsBuffer.destroy();
  return {
    width,
    height,
    rowStride,
    layers,
    buffer: dstBuffer,
    destroy() {
      dstBuffer.destroy();
    }
  };
}

// wgsl-raw:C:\Users\gauch\code\vectorizor\cleanplans-web\src\gpu\shaders\guo_hall_thin.wgsl
var guo_hall_thin_default = `// Guo-Hall parallel thinning \u2014 one pass (phase 0 or 1) over a packed\r
// 1-bit-per-pixel image.\r
//\r
// Reference: Z. Guo and R. W. Hall, "Parallel thinning with two-subiteration\r
// algorithms", Commun. ACM, 32(3):359\u2013373, 1989.\r
//\r
// Neighbor labeling (standard):\r
//   P9 P2 P3\r
//   P8 P1 P4\r
//   P7 P6 P5\r
//\r
// Phase 0 deletes P1 if:\r
//   2 \u2264 N(P1) \u2264 6  \u2227  C(P1)=1  \u2227  P2\xB7P4\xB7P8=0  \u2227  P2\xB7P4\xB7P6=0\r
//\r
// Phase 1 deletes P1 if:\r
//   2 \u2264 N(P1) \u2264 6  \u2227  C(P1)=1  \u2227  P2\xB7P6\xB7P8=0  \u2227  P4\xB7P6\xB7P8=0\r
//\r
// Buffer layout matches palette_decompose.wgsl:\r
//   All layers packed sequentially; layer i starts at word offset\r
//   layerBase = i * rowStride * height.\r
//\r
// Workgroup: 32\xD71 threads \u2192 one u32 word per workgroup (32 pixels \xD7 1 row).\r
// Dispatch:  (rowStride, height, 1)\r
\r
struct Dims {\r
    width:     u32,   // image width in pixels\r
    height:    u32,   // image height in pixels\r
    rowStride: u32,   // u32 words per row = ceil(width / 32)\r
    phase:     u32,   // 0 = sub-iteration 1, 1 = sub-iteration 2\r
    layerBase: u32,   // word offset into buffer for the start of this layer\r
    _pad0:     u32,\r
    _pad1:     u32,\r
    _pad2:     u32,\r
}\r
\r
@group(0) @binding(0) var<uniform>             dims:    Dims;\r
@group(0) @binding(1) var<storage, read>       input:   array<u32>;\r
@group(0) @binding(2) var<storage, read_write> output:  array<u32>;\r
@group(0) @binding(3) var<storage, read_write> changed: array<atomic<u32>>;\r
\r
// Shared deletion mask for 32 pixels in this workgroup's word.\r
var<workgroup> wg_delete: atomic<u32>;\r
\r
// ---------------------------------------------------------------------------\r
// Bit helpers\r
// ---------------------------------------------------------------------------\r
\r
fn get_bit(x: i32, y: i32) -> u32 {\r
    if (x < 0 || y < 0 || u32(x) >= dims.width || u32(y) >= dims.height) {\r
        return 0u;\r
    }\r
    let idx = dims.layerBase + u32(y) * dims.rowStride + (u32(x) >> 5u);\r
    return (input[idx] >> (u32(x) & 31u)) & 1u;\r
}\r
\r
// Count 0\u21921 transitions in the cyclic sequence P2,P3,P4,P5,P6,P7,P8,P9,(P2).\r
fn crossing_number(\r
    p2: u32, p3: u32, p4: u32, p5: u32,\r
    p6: u32, p7: u32, p8: u32, p9: u32,\r
) -> u32 {\r
    var c = 0u;\r
    c += u32(p2 == 0u && p3 == 1u);\r
    c += u32(p3 == 0u && p4 == 1u);\r
    c += u32(p4 == 0u && p5 == 1u);\r
    c += u32(p5 == 0u && p6 == 1u);\r
    c += u32(p6 == 0u && p7 == 1u);\r
    c += u32(p7 == 0u && p8 == 1u);\r
    c += u32(p8 == 0u && p9 == 1u);\r
    c += u32(p9 == 0u && p2 == 1u);\r
    return c;\r
}\r
\r
// ---------------------------------------------------------------------------\r
// Main\r
// ---------------------------------------------------------------------------\r
\r
@compute @workgroup_size(32, 1)\r
fn main(\r
    @builtin(local_invocation_id) lid:  vec3<u32>,\r
    @builtin(workgroup_id)        wgid: vec3<u32>,\r
) {\r
    // Zero shared deletion mask (workgroup memory is spec-guaranteed zero at\r
    // invocation start, but explicit init + barrier is clearer).\r
    if (lid.x == 0u) { atomicStore(&wg_delete, 0u); }\r
    workgroupBarrier();\r
\r
    let word_x = wgid.x;  // u32-column index (0 .. rowStride-1)\r
    let word_y = wgid.y;  // row index         (0 .. height-1)\r
    let thread = lid.x;   // bit index in word (0 .. 31)\r
\r
    let x = i32(word_x * 32u + thread);\r
    let y = i32(word_y);\r
\r
    if (u32(x) < dims.width && u32(y) < dims.height) {\r
        let center = get_bit(x, y);\r
        if (center == 1u) {\r
            // 8-connected neighbours (north = decreasing y)\r
            let p2 = get_bit(x,     y - 1); // N\r
            let p3 = get_bit(x + 1, y - 1); // NE\r
            let p4 = get_bit(x + 1, y);     // E\r
            let p5 = get_bit(x + 1, y + 1); // SE\r
            let p6 = get_bit(x,     y + 1); // S\r
            let p7 = get_bit(x - 1, y + 1); // SW\r
            let p8 = get_bit(x - 1, y);     // W\r
            let p9 = get_bit(x - 1, y - 1); // NW\r
\r
            let n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;\r
            let c = crossing_number(p2, p3, p4, p5, p6, p7, p8, p9);\r
\r
            var should_delete = false;\r
            if (n >= 2u && n <= 6u && c == 1u) {\r
                if (dims.phase == 0u) {\r
                    should_delete = (p2 * p4 * p8 == 0u) && (p2 * p4 * p6 == 0u);\r
                } else {\r
                    should_delete = (p2 * p6 * p8 == 0u) && (p4 * p6 * p8 == 0u);\r
                }\r
            }\r
\r
            if (should_delete) {\r
                atomicOr(&wg_delete, 1u << thread);\r
            }\r
        }\r
    }\r
    workgroupBarrier();\r
\r
    // Thread 0 applies the deletion mask and signals whether anything changed.\r
    if (lid.x == 0u) {\r
        let word_idx = dims.layerBase + word_y * dims.rowStride + word_x;\r
        let del_bits = atomicLoad(&wg_delete);\r
        output[word_idx] = input[word_idx] & ~del_bits;\r
        if (del_bits != 0u) {\r
            atomicOr(&changed[0], 1u);\r
        }\r
    }\r
}\r
`;

// src/gpu/cpu_fallback.ts
var MAX_ROUNDS = 512;
function makeCpuDecomposition(words, width, height, rowStride, layers) {
  return {
    width,
    height,
    rowStride,
    layers,
    // CPU-backed decomposition: `buffer` must never be dereferenced — every
    // reader is required to check `cpuWords` first.
    buffer: null,
    cpuWords: words,
    destroy() {
    }
  };
}
function thinDecompositionCPU(decomp) {
  const { width, height, rowStride, layers } = decomp;
  const src = decomp.cpuWords;
  if (!src) throw new Error("thinDecompositionCPU requires a CPU-backed decomposition");
  const layerWords = rowStride * height;
  const out = new Uint32Array(src);
  for (let li = 0; li < layers.length; li++) {
    const base = li * layerWords;
    const px = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const w = out[base + y * rowStride + (x >>> 5)];
        if (w >>> (x & 31) & 1) px[y * width + x] = 1;
      }
    }
    const next = new Uint8Array(px);
    const get = (x, y) => x < 0 || y < 0 || x >= width || y >= height ? 0 : px[y * width + x];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      let changed = false;
      for (let phase = 0; phase < 2; phase++) {
        next.set(px);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (!px[y * width + x]) continue;
            const p2 = get(x, y - 1), p3 = get(x + 1, y - 1);
            const p4 = get(x + 1, y), p5 = get(x + 1, y + 1);
            const p6 = get(x, y + 1), p7 = get(x - 1, y + 1);
            const p8 = get(x - 1, y), p9 = get(x - 1, y - 1);
            const n = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
            if (n < 2 || n > 6) continue;
            let c = 0;
            if (!p2 && p3) c++;
            if (!p3 && p4) c++;
            if (!p4 && p5) c++;
            if (!p5 && p6) c++;
            if (!p6 && p7) c++;
            if (!p7 && p8) c++;
            if (!p8 && p9) c++;
            if (!p9 && p2) c++;
            if (c !== 1) continue;
            const del = phase === 0 ? p2 * p4 * p8 === 0 && p2 * p4 * p6 === 0 : p2 * p6 * p8 === 0 && p4 * p6 * p8 === 0;
            if (del) {
              next[y * width + x] = 0;
              changed = true;
            }
          }
        }
        px.set(next);
      }
      if (!changed) break;
    }
    for (let y = 0; y < height; y++) {
      for (let wx = 0; wx < rowStride; wx++) {
        let w = 0;
        const x0 = wx << 5;
        const lim = Math.min(32, width - x0);
        for (let b = 0; b < lim; b++) {
          if (px[y * width + x0 + b]) w |= 1 << b;
        }
        out[base + y * rowStride + wx] = w >>> 0;
      }
    }
  }
  return makeCpuDecomposition(out, width, height, rowStride, layers);
}

// src/gpu/guo_hall_thin.ts
var cachedPipeline4 = null;
function getOrCreatePipeline4(device) {
  if (cachedPipeline4 && cachedPipeline4.device === device) return cachedPipeline4;
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ]
  });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    compute: {
      module: device.createShaderModule({ code: guo_hall_thin_default }),
      entryPoint: "main"
    }
  });
  cachedPipeline4 = { device, pipeline, bgl };
  return cachedPipeline4;
}
function makeUniforms(device, width, height, rowStride, phase, layerBase) {
  const data = new Uint32Array([width, height, rowStride, phase, layerBase, 0, 0, 0]);
  const buf = device.createBuffer({
    size: data.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(buf.getMappedRange()).set(data);
  buf.unmap();
  return buf;
}
var MAX_ROUNDS2 = 512;
var BATCH_SIZE = 16;
async function thinDecomposition(device, decomp) {
  const { width, height, rowStride, layers, buffer } = decomp;
  const numLayers = layers.length;
  if (numLayers === 0) {
    const buf = device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });
    return {
      width,
      height,
      rowStride,
      layers: [],
      buffer: buf,
      destroy() {
        buf.destroy();
      }
    };
  }
  const { pipeline, bgl } = getOrCreatePipeline4(device);
  const layerWords = rowStride * height;
  const totalBytes = numLayers * layerWords * 4;
  const bufA = device.createBuffer({
    size: totalBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const bufB = device.createBuffer({
    size: totalBytes,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const changedBuf = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
  });
  const changedStaging = device.createBuffer({
    size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  {
    const enc2 = device.createCommandEncoder();
    enc2.copyBufferToBuffer(buffer, 0, bufA, 0, totalBytes);
    device.queue.submit([enc2.finish()]);
  }
  const unifP0 = [];
  const unifP1 = [];
  const bgP0 = [];
  const bgP1 = [];
  for (let li = 0; li < numLayers; li++) {
    const layerBase = li * layerWords;
    const u0 = makeUniforms(device, width, height, rowStride, 0, layerBase);
    const u1 = makeUniforms(device, width, height, rowStride, 1, layerBase);
    unifP0.push(u0);
    unifP1.push(u1);
    bgP0.push(device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: u0 } },
        { binding: 1, resource: { buffer: bufA } },
        { binding: 2, resource: { buffer: bufB } },
        { binding: 3, resource: { buffer: changedBuf } }
      ]
    }));
    bgP1.push(device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: u1 } },
        { binding: 1, resource: { buffer: bufB } },
        { binding: 2, resource: { buffer: bufA } },
        { binding: 3, resource: { buffer: changedBuf } }
      ]
    }));
  }
  const dispatchX = rowStride;
  const dispatchY = height;
  let totalRounds = 0;
  outer:
    for (; ; ) {
      const batchRounds = Math.min(BATCH_SIZE, MAX_ROUNDS2 - totalRounds);
      if (batchRounds <= 0) break;
      const enc2 = device.createCommandEncoder();
      enc2.clearBuffer(changedBuf);
      for (let r = 0; r < batchRounds; r++) {
        {
          const pass = enc2.beginComputePass();
          pass.setPipeline(pipeline);
          for (let li = 0; li < numLayers; li++) {
            pass.setBindGroup(0, bgP0[li]);
            pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
          }
          pass.end();
        }
        {
          const pass = enc2.beginComputePass();
          pass.setPipeline(pipeline);
          for (let li = 0; li < numLayers; li++) {
            pass.setBindGroup(0, bgP1[li]);
            pass.dispatchWorkgroups(dispatchX, dispatchY, 1);
          }
          pass.end();
        }
      }
      enc2.copyBufferToBuffer(changedBuf, 0, changedStaging, 0, 4);
      device.queue.submit([enc2.finish()]);
      await changedStaging.mapAsync(GPUMapMode.READ);
      const changedVal = new Uint32Array(changedStaging.getMappedRange())[0];
      changedStaging.unmap();
      totalRounds += batchRounds;
      if (changedVal === 0 || totalRounds >= MAX_ROUNDS2) break outer;
    }
  for (let li = 0; li < numLayers; li++) {
    unifP0[li].destroy();
    unifP1[li].destroy();
  }
  bufB.destroy();
  changedBuf.destroy();
  changedStaging.destroy();
  return {
    width,
    height,
    rowStride,
    layers,
    // same metadata as input
    buffer: bufA,
    destroy() {
      bufA.destroy();
    }
  };
}
async function readDecompositionWords(device, decomp) {
  const { rowStride, height, layers, buffer } = decomp;
  const totalBytes = layers.length * rowStride * height * 4;
  const staging = device.createBuffer({
    size: totalBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  try {
    const enc2 = device.createCommandEncoder();
    enc2.copyBufferToBuffer(buffer, 0, staging, 0, totalBytes);
    device.queue.submit([enc2.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    return words;
  } finally {
    staging.destroy();
  }
}
async function thinDecompositionAuto(device, decomp, opts = {}) {
  if (!opts.forceCpu) return await thinDecomposition(device, decomp);
  const words = decomp.cpuWords ?? await readDecompositionWords(device, decomp);
  const cpuDecomp = makeCpuDecomposition(
    words,
    decomp.width,
    decomp.height,
    decomp.rowStride,
    decomp.layers
  );
  return thinDecompositionCPU(cpuDecomp);
}

// src/gpu/path_connect.ts
function buildAdjacency(pixels, width, height) {
  const adj = /* @__PURE__ */ new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[y * width + x]) continue;
      const hasN = y > 0 && !!pixels[(y - 1) * width + x];
      const hasS = y < height - 1 && !!pixels[(y + 1) * width + x];
      const hasE = x < width - 1 && !!pixels[y * width + (x + 1)];
      const hasW = x > 0 && !!pixels[y * width + (x - 1)];
      const hasNE = y > 0 && x < width - 1 && !!pixels[(y - 1) * width + (x + 1)];
      const hasSE = y < height - 1 && x < width - 1 && !!pixels[(y + 1) * width + (x + 1)];
      const hasSW = y < height - 1 && x > 0 && !!pixels[(y + 1) * width + (x - 1)];
      const hasNW = y > 0 && x > 0 && !!pixels[(y - 1) * width + (x - 1)];
      const neighbors = [];
      if (hasN) neighbors.push((y - 1) * width + x);
      if (hasS) neighbors.push((y + 1) * width + x);
      if (hasE) neighbors.push(y * width + (x + 1));
      if (hasW) neighbors.push(y * width + (x - 1));
      if (hasNE && !hasN && !hasE) neighbors.push((y - 1) * width + (x + 1));
      if (hasSE && !hasS && !hasE) neighbors.push((y + 1) * width + (x + 1));
      if (hasSW && !hasS && !hasW) neighbors.push((y + 1) * width + (x - 1));
      if (hasNW && !hasN && !hasW) neighbors.push((y - 1) * width + (x - 1));
      adj.set(y * width + x, neighbors);
    }
  }
  return adj;
}
function unpackLayer(words, layerOffset, width, height, rowStride) {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const wordIdx = layerOffset + y * rowStride + (x >>> 5);
      const bit = words[wordIdx] >>> (x & 31) & 1;
      pixels[y * width + x] = bit;
    }
  }
  return pixels;
}
function buildLayerGraph(pixels, width, height, layerIndex, outVertices, outEdges) {
  const adj = buildAdjacency(pixels, width, height);
  if (adj.size === 0) return;
  const pixelToVertex = /* @__PURE__ */ new Map();
  for (const [idx, neighbors] of adj) {
    const x = idx % width;
    const y = (idx - x) / width;
    const degree = neighbors.length;
    let type;
    if (degree === 0) type = "isolated";
    else if (degree === 1) type = "endpoint";
    else if (degree === 2) type = "chain";
    else type = "junction";
    pixelToVertex.set(idx, outVertices.length);
    outVertices.push({ x, y, layer: layerIndex, type });
  }
  for (const [idx, neighbors] of adj) {
    const fromV = pixelToVertex.get(idx);
    for (const nidx of neighbors) {
      if (nidx > idx) {
        const toV = pixelToVertex.get(nidx);
        if (toV !== void 0) {
          outEdges.push({ from: fromV, to: toV, layer: layerIndex });
        }
      }
    }
  }
}
async function connectPaths(device, decomp) {
  const { width, height, rowStride, layers, buffer } = decomp;
  const numLayers = layers.length;
  if (numLayers === 0) {
    return { width, height, layerCount: 0, vertices: [], edges: [] };
  }
  const layerWords = rowStride * height;
  const totalBytes = numLayers * layerWords * 4;
  let words;
  let staging = null;
  if (decomp.cpuWords) {
    words = decomp.cpuWords;
  } else {
    if (!device) {
      throw new Error("connectPaths: no GPU device and no cpuWords fallback");
    }
    staging = device.createBuffer({
      size: totalBytes,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
    });
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, staging, 0, totalBytes);
    device.queue.submit([encoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    words = new Uint32Array(staging.getMappedRange());
  }
  const vertices = [];
  const edges = [];
  for (let li = 0; li < numLayers; li++) {
    const layerOffset = li * layerWords;
    const pixels = unpackLayer(words, layerOffset, width, height, rowStride);
    buildLayerGraph(pixels, width, height, li, vertices, edges);
  }
  if (staging) {
    staging.unmap();
    staging.destroy();
  }
  return { width, height, layerCount: numLayers, vertices, edges };
}

// src/gpu/path_simplify.ts
function perpDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = px - ax, ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const t = ((px - ax) * dx + (py - ay) * dy) / len2;
  const fx = ax + t * dx - px;
  const fy = ay + t * dy - py;
  return Math.sqrt(fx * fx + fy * fy);
}
function dpRecurse(xs, ys, keep, start, end, tolerance) {
  if (end <= start + 1) return;
  let maxDist = 0;
  let maxIdx = start;
  for (let i = start + 1; i < end; i++) {
    const d = perpDist(xs[i], ys[i], xs[start], ys[start], xs[end], ys[end]);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist > tolerance) {
    keep[maxIdx] = 1;
    dpRecurse(xs, ys, keep, start, maxIdx, tolerance);
    dpRecurse(xs, ys, keep, maxIdx, end, tolerance);
  }
}
function vertexDist(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
function simplifyPathGraph(graph, tolerance) {
  const { width, height, layerCount, vertices, edges } = graph;
  if (vertices.length === 0) {
    return { width, height, layerCount, vertices: [], edges: [] };
  }
  const adj = Array.from({ length: vertices.length }, () => []);
  for (const edge of edges) {
    adj[edge.from].push(edge.to);
    adj[edge.to].push(edge.from);
  }
  const runs = [];
  const chainVisited = new Uint8Array(vertices.length);
  for (let i = 0; i < vertices.length; i++) {
    if (vertices[i].type === "chain") continue;
    for (const n of adj[i]) {
      if (vertices[n].type !== "chain" || chainVisited[n]) continue;
      const path = [i, n];
      chainVisited[n] = 1;
      let prev = i, curr = n;
      while (true) {
        const next = adj[curr].find((x) => x !== prev);
        if (next === void 0) break;
        if (vertices[next].type !== "chain" || chainVisited[next]) {
          path.push(next);
          break;
        }
        chainVisited[next] = 1;
        path.push(next);
        prev = curr;
        curr = next;
      }
      runs.push({ path, circular: false });
    }
  }
  for (let i = 0; i < vertices.length; i++) {
    if (vertices[i].type !== "chain" || chainVisited[i]) continue;
    const ring = [i];
    chainVisited[i] = 1;
    let prev = -1, curr = i;
    while (true) {
      const next = adj[curr].find((x) => x !== prev && !chainVisited[x]);
      if (next === void 0) break;
      chainVisited[next] = 1;
      ring.push(next);
      prev = curr;
      curr = next;
    }
    runs.push({ path: ring, circular: true });
  }
  const keepVertex = new Uint8Array(vertices.length);
  for (let i = 0; i < vertices.length; i++) {
    if (vertices[i].type !== "chain") keepVertex[i] = 1;
  }
  for (const { path, circular } of runs) {
    const n = path.length;
    if (n <= 2) {
      for (const idx of path) keepVertex[idx] = 1;
      continue;
    }
    if (circular) {
      const rn = n + 1;
      const rxs = new Float64Array(rn);
      const rys = new Float64Array(rn);
      for (let j = 0; j < n; j++) {
        rxs[j] = vertices[path[j]].x;
        rys[j] = vertices[path[j]].y;
      }
      rxs[n] = rxs[0];
      rys[n] = rys[0];
      const rKeep = new Uint8Array(rn);
      rKeep[0] = 1;
      rKeep[n] = 1;
      dpRecurse(rxs, rys, rKeep, 0, n, tolerance);
      for (let j = 0; j < n; j++) {
        if (rKeep[j]) keepVertex[path[j]] = 1;
      }
      keepVertex[path[0]] = 1;
    } else {
      const xs = new Float64Array(n);
      const ys = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        xs[j] = vertices[path[j]].x;
        ys[j] = vertices[path[j]].y;
      }
      const keep = new Uint8Array(n);
      keep[0] = 1;
      keep[n - 1] = 1;
      dpRecurse(xs, ys, keep, 0, n - 1, tolerance);
      for (let j = 0; j < n; j++) {
        if (keep[j]) keepVertex[path[j]] = 1;
      }
    }
  }
  const oldToNew = new Int32Array(vertices.length).fill(-1);
  const newVertices = [];
  for (let i = 0; i < vertices.length; i++) {
    if (keepVertex[i]) {
      oldToNew[i] = newVertices.length;
      newVertices.push({ ...vertices[i] });
    }
  }
  const newEdges = [];
  for (const { path, circular } of runs) {
    const kept = [];
    for (const idx of path) {
      const ni = oldToNew[idx];
      if (ni >= 0) kept.push(ni);
    }
    if (circular) {
      for (let j = 0; j < kept.length; j++) {
        const a = kept[j];
        const b = kept[(j + 1) % kept.length];
        const layer = vertices[path[j]].layer;
        newEdges.push({ from: Math.min(a, b), to: Math.max(a, b), layer });
      }
    } else {
      for (let j = 0; j < kept.length - 1; j++) {
        const a = kept[j];
        const b = kept[j + 1];
        const layer = vertices[path[j]].layer;
        newEdges.push({ from: Math.min(a, b), to: Math.max(a, b), layer });
      }
    }
  }
  for (const edge of edges) {
    if (vertices[edge.from].type !== "chain" && vertices[edge.to].type !== "chain") {
      const from = oldToNew[edge.from];
      const to = oldToNew[edge.to];
      if (from >= 0 && to >= 0) {
        newEdges.push({ from: Math.min(from, to), to: Math.max(from, to), layer: edge.layer });
      }
    }
  }
  return { width, height, layerCount, vertices: newVertices, edges: newEdges };
}
function continuesThrough(verts, adj, junction, armEnd, maxLength) {
  const j = verts[junction];
  const inX = j.x - verts[armEnd].x, inY = j.y - verts[armEnd].y;
  const inLen = Math.hypot(inX, inY);
  if (inLen < 1e-9) return false;
  const ux = inX / inLen, uy = inY / inLen;
  for (const nb of adj[junction]) {
    if (nb === armEnd) continue;
    let prev = junction, curr = nb, run = vertexDist(j, verts[nb]);
    while (adj[curr].length === 2 && run <= maxLength) {
      let next = -1;
      for (const n of adj[curr]) if (n !== prev) {
        next = n;
        break;
      }
      if (next === -1) break;
      run += vertexDist(verts[curr], verts[next]);
      prev = curr;
      curr = next;
    }
    if (run > maxLength) continue;
    const ox = verts[curr].x - j.x, oy = verts[curr].y - j.y;
    const oLen = Math.hypot(ox, oy);
    if (oLen < 1e-9) continue;
    if ((ux * ox + uy * oy) / oLen >= 0.95) return true;
  }
  return false;
}
function inkProbeFromWords(words, width, height, rowStride) {
  const layerWords = rowStride * height;
  return (x, y, layer) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = layer * layerWords + y * rowStride + (x >>> 5);
    return (words[i] >>> (x & 31) & 1) === 1;
  };
}
function inkReach(ink, verts, tipIdx, junctIdx, maxWalk) {
  if (!ink) return 0;
  const tip = verts[tipIdx], jv = verts[junctIdx];
  const bx = tip.x - jv.x, by = tip.y - jv.y;
  const bl = Math.hypot(bx, by);
  if (bl < 1e-9) return 0;
  const ux = bx / bl, uy = by / bl;
  let reach = 0;
  for (let d = 0.5; d <= maxWalk; d += 0.5) {
    if (!ink(Math.round(jv.x + ux * d), Math.round(jv.y + uy * d), tip.layer)) break;
    reach = d;
  }
  return reach;
}
function leavesTheStroke(verts, adj, junction, armEnd) {
  const jv = verts[junction], av = verts[armEnd];
  const ax = av.x - jv.x, ay = av.y - jv.y;
  const al = Math.hypot(ax, ay);
  if (al < 1e-9) return false;
  const COS_LIMIT = Math.cos(25 * Math.PI / 180);
  for (const n of adj[junction]) {
    if (n === armEnd) continue;
    const nv = verts[n];
    const nx = nv.x - jv.x, ny = nv.y - jv.y;
    const nl = Math.hypot(nx, ny);
    if (nl < 1e-9) continue;
    const cos = (ax * nx + ay * ny) / (al * nl);
    if (Math.abs(cos) >= COS_LIMIT) return false;
  }
  return true;
}
function removeSpurs(graph, maxLength, ink, outMarks) {
  let verts = graph.vertices.map((v) => ({ ...v }));
  let edgs = graph.edges.map((e) => ({ ...e }));
  for (let pass = 0; pass < 1e3; pass++) {
    const adj = Array.from({ length: verts.length }, () => []);
    for (const e of edgs) {
      adj[e.from].push(e.to);
      adj[e.to].push(e.from);
    }
    const removeVerts = /* @__PURE__ */ new Set();
    for (let i = 0; i < verts.length; i++) {
      if (adj[i].length !== 1) continue;
      if (removeVerts.has(i)) continue;
      const spurPath = [i];
      let prev = -1, curr = i;
      let arcLen = 0;
      let endsAtJunction = false;
      traceLoop: while (true) {
        let next = -1;
        for (const n of adj[curr]) {
          if (n !== prev) {
            next = n;
            break;
          }
        }
        if (next === -1) break;
        arcLen += vertexDist(verts[curr], verts[next]);
        spurPath.push(next);
        const nextDeg = adj[next].length;
        if (nextDeg === 1) {
          endsAtJunction = false;
          break traceLoop;
        }
        if (nextDeg >= 3) {
          endsAtJunction = true;
          break traceLoop;
        }
        if (arcLen > maxLength) {
          endsAtJunction = false;
          break traceLoop;
        }
        prev = curr;
        curr = next;
      }
      if (endsAtJunction && arcLen <= maxLength) {
        const junction = spurPath[spurPath.length - 1];
        const armEnd = spurPath[spurPath.length - 2];
        if (!continuesThrough(verts, adj, junction, armEnd, maxLength)) {
          if (outMarks && ink && leavesTheStroke(verts, adj, junction, armEnd)) {
            const reach = inkReach(ink, verts, spurPath[0], junction, maxLength * 3);
            if (reach > maxLength) {
              const tip = verts[spurPath[0]], jv = verts[junction];
              const bl = Math.hypot(tip.x - jv.x, tip.y - jv.y) || 1;
              const ux = (tip.x - jv.x) / bl, uy = (tip.y - jv.y) / bl;
              outMarks.push({
                x1: jv.x,
                y1: jv.y,
                x2: jv.x + ux * reach,
                y2: jv.y + uy * reach,
                layer: tip.layer
              });
            }
          }
          for (let k = 0; k < spurPath.length - 1; k++) {
            removeVerts.add(spurPath[k]);
          }
        }
      }
    }
    if (removeVerts.size === 0) break;
    edgs = edgs.filter((e) => !removeVerts.has(e.from) && !removeVerts.has(e.to));
    const oldToNew = new Int32Array(verts.length).fill(-1);
    let nextIdx = 0;
    verts = verts.filter((_, i) => {
      if (removeVerts.has(i)) return false;
      oldToNew[i] = nextIdx++;
      return true;
    });
    edgs = edgs.map((e) => ({ from: oldToNew[e.from], to: oldToNew[e.to], layer: e.layer }));
    const newAdj = Array.from({ length: verts.length }, () => []);
    for (const e of edgs) {
      newAdj[e.from].push(e.to);
      newAdj[e.to].push(e.from);
    }
    for (let i = 0; i < verts.length; i++) {
      const d = newAdj[i].length;
      verts[i].type = d === 0 ? "isolated" : d === 1 ? "endpoint" : d === 2 ? "chain" : "junction";
    }
  }
  const finalAdj = Array.from({ length: verts.length }, () => []);
  for (const e of edgs) {
    finalAdj[e.from].push(e.to);
    finalAdj[e.to].push(e.from);
  }
  const finalOToN = new Int32Array(verts.length).fill(-1);
  let fi = 0;
  const finalVerts = verts.filter((_, i) => {
    if (finalAdj[i].length === 0) return false;
    finalOToN[i] = fi++;
    return true;
  });
  const finalEdgs = edgs.map((e) => ({
    from: finalOToN[e.from],
    to: finalOToN[e.to],
    layer: e.layer
  }));
  return {
    width: graph.width,
    height: graph.height,
    layerCount: graph.layerCount,
    vertices: finalVerts,
    edges: finalEdgs
  };
}

// src/gpu/curve_fit_math.ts
function dist2(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
}
function fitCircle(xs, ys) {
  const n = xs.length;
  if (n < 3) return { rmsError: Infinity, cx: 0, cy: 0, r: 0, valid: false };
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let A00 = 0, A01 = 0, A02 = 0, A11 = 0, A12 = 0, A22 = n;
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const xi = xs[i] - mx, yi = ys[i] - my;
    const zi = xi * xi + yi * yi;
    A00 += 4 * xi * xi;
    A01 += 4 * xi * yi;
    A02 += 2 * xi;
    A11 += 4 * yi * yi;
    A12 += 2 * yi;
    b0 += 2 * xi * zi;
    b1 += 2 * yi * zi;
    b2 += zi;
  }
  const det = A00 * (A11 * A22 - A12 * A12) - A01 * (A01 * A22 - A12 * A02) + A02 * (A01 * A12 - A11 * A02);
  if (Math.abs(det) < 1e-14) {
    return { rmsError: Infinity, cx: 0, cy: 0, r: 0, valid: false };
  }
  const inv = 1 / det;
  const a = (b0 * (A11 * A22 - A12 * A12) - A01 * (b1 * A22 - A12 * b2) + A02 * (b1 * A12 - A11 * b2)) * inv;
  const b = (A00 * (b1 * A22 - A12 * b2) - b0 * (A01 * A22 - A12 * A02) + A02 * (A01 * b2 - b1 * A02)) * inv;
  const c = (A00 * (A11 * b2 - b1 * A12) - A01 * (A01 * b2 - b1 * A02) + b0 * (A01 * A12 - A11 * A02)) * inv;
  const cx = a + mx, cy = b + my;
  const r2 = a * a + b * b + c;
  if (r2 < 0) return { rmsError: Infinity, cx, cy, r: 0, valid: false };
  const r = Math.sqrt(r2);
  let sumErr2 = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.sqrt(dist2(xs[i], ys[i], cx, cy)) - r;
    sumErr2 += d * d;
  }
  return { rmsError: Math.sqrt(sumErr2 / n), cx, cy, r, valid: true };
}
function makeLinePrimitive(x1, y1, x2, y2) {
  return { type: "line", x1, y1, x2, y2 };
}
function ccwSpan(from, to) {
  let s = to - from;
  while (s <= 0) s += 2 * Math.PI;
  while (s > 2 * Math.PI) s -= 2 * Math.PI;
  return s;
}
function makeArcPrimitive(fit, startAngle, endAngle, ccw, sweep) {
  return {
    type: "arc",
    cx: fit.cx,
    cy: fit.cy,
    r: fit.r,
    startAngle,
    endAngle,
    ccw,
    sweep
  };
}
function windowAdd(win, vs, vi) {
  const b = vi * 6;
  win[0] += vs[b];
  win[1] += vs[b + 1];
  win[2] += vs[b + 2];
  win[3] += vs[b + 3];
  win[4] += vs[b + 4];
  win[5] += vs[b + 5];
}
function dirFromWindowInto(win, out) {
  const n = win[0];
  if (n < 2) {
    out[0] = 1;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;
    out[4] = 0;
    return;
  }
  const cx = win[1] / n, cy = win[2] / n;
  const cxx = win[3] / n - cx * cx;
  const cxy = win[4] / n - cx * cy;
  const cyy = win[5] / n - cy * cy;
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const lam1 = trace / 2 + disc;
  const lam2 = trace / 2 - disc;
  let dirX, dirY;
  if (Math.abs(cxy) > 1e-12) {
    dirX = lam1 - cyy;
    dirY = cxy;
  } else {
    dirX = cxx >= cyy ? 1 : 0;
    dirY = cxx >= cyy ? 0 : 1;
  }
  const norm = Math.hypot(dirX, dirY);
  if (norm > 1e-12) {
    dirX /= norm;
    dirY /= norm;
  }
  out[0] = dirX;
  out[1] = dirY;
  out[2] = cx;
  out[3] = cy;
  out[4] = Math.sqrt(Math.max(0, lam2));
}
function dirFromWindow(win) {
  const n = win[0];
  if (n < 2) return { dirX: 1, dirY: 0, cx: 0, cy: 0, rmsError: 0 };
  const cx = win[1] / n, cy = win[2] / n;
  const cxx = win[3] / n - cx * cx;
  const cxy = win[4] / n - cx * cy;
  const cyy = win[5] / n - cy * cy;
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const lam1 = trace / 2 + disc;
  const lam2 = trace / 2 - disc;
  const rmsError = Math.sqrt(Math.max(0, lam2));
  let dirX, dirY;
  if (Math.abs(cxy) > 1e-12) {
    dirX = lam1 - cyy;
    dirY = cxy;
  } else {
    dirX = cxx >= cyy ? 1 : 0;
    dirY = cxx >= cyy ? 0 : 1;
  }
  const norm = Math.hypot(dirX, dirY);
  if (norm > 1e-12) {
    dirX /= norm;
    dirY /= norm;
  }
  return { dirX, dirY, cx, cy, rmsError };
}
function lineCEFast(vs, vertStart, vertEnd, cx, cy, dirX, dirY) {
  const perpX = -dirY, perpY = dirX;
  let sumMean2 = 0, validVerts = 0;
  for (let vi = vertStart; vi <= vertEnd; vi++) {
    const b = vi * 6;
    const n = vs[b];
    if (n < 2) continue;
    const mean = ((vs[b + 1] - n * cx) * perpX + (vs[b + 2] - n * cy) * perpY) / n;
    sumMean2 += mean * mean;
    validVerts++;
  }
  return validVerts > 0 ? Math.sqrt(sumMean2 / validVerts) : 0;
}
function lineLineIntersect(x1, y1, dx0, dy0, x2, y2, dx1, dy1) {
  const denom = dx0 * dy1 - dy0 * dx1;
  if (Math.abs(denom) < 1e-10) return null;
  const t = ((x2 - x1) * dy1 - (y2 - y1) * dx1) / denom;
  return { x: x1 + t * dx0, y: y1 + t * dy0 };
}
function primitiveTangentAt(p, atStart) {
  if (p.type === "line") {
    const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-10) return { tx: 1, ty: 0 };
    return { tx: dx / len, ty: dy / len };
  }
  const theta = atStart ? p.startAngle : p.endAngle;
  if (p.ccw) return { tx: -Math.sin(theta), ty: Math.cos(theta) };
  else return { tx: Math.sin(theta), ty: -Math.cos(theta) };
}
function primitiveEndPoint(p, atStart) {
  if (p.type === "line") {
    return atStart ? { x: p.x1, y: p.y1 } : { x: p.x2, y: p.y2 };
  }
  const theta = atStart ? p.startAngle : p.endAngle;
  return { x: p.cx + p.r * Math.cos(theta), y: p.cy + p.r * Math.sin(theta) };
}
var MAX_SWEEP = Math.PI * 1.15;
function snapArcAngle(p, theta, atStart) {
  let spanCCW;
  if (atStart) {
    spanCCW = ccwSpan(theta, p.endAngle);
  } else {
    spanCCW = ccwSpan(p.startAngle, theta);
  }
  const sweep = p.ccw ? spanCCW : 2 * Math.PI - spanCCW;
  if (sweep <= 0 || sweep > MAX_SWEEP) return false;
  if (atStart) p.startAngle = theta;
  else p.endAngle = theta;
  p.sweep = sweep;
  return true;
}
function lineCircleTs(x0, y0, dx, dy, cx, cy, r) {
  const fx = x0 - cx, fy = y0 - cy;
  const a = dx * dx + dy * dy;
  if (a < 1e-20) return [];
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [(-b - sq) / (2 * a), (-b + sq) / (2 * a)];
}
function circleCircleIntersect(c0x, c0y, r0, c1x, c1y, r1) {
  const dx = c1x - c0x, dy = c1y - c0y;
  const d = Math.hypot(dx, dy);
  if (d < 1e-9) return null;
  if (d > r0 + r1 || d < Math.abs(r0 - r1)) return null;
  const a = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h2 = r0 * r0 - a * a;
  if (h2 < 0) return null;
  const h = Math.sqrt(h2);
  const bx = c0x + a * dx / d, by = c0y + a * dy / d;
  const px = -dy / d * h, py = dx / d * h;
  return [{ x: bx + px, y: by + py }, { x: bx - px, y: by - py }];
}
var ARC_JOIN_MAX_MOVE = 3;
function reanchorArcThrough(p, Jx, Jy, atStart) {
  const thetaA = atStart ? p.endAngle : p.startAngle;
  const Ax = p.cx + p.r * Math.cos(thetaA);
  const Ay = p.cy + p.r * Math.sin(thetaA);
  const Nx = (p.cx - Ax) / p.r, Ny = (p.cy - Ay) / p.r;
  const wx = Jx - Ax, wy = Jy - Ay;
  const nw = Nx * wx + Ny * wy;
  const w2 = wx * wx + wy * wy;
  if (nw <= 1e-9 || w2 < 1e-12) return false;
  const t = w2 / (2 * nw);
  if (!(t >= 1) || !Number.isFinite(t)) return false;
  if (t > p.r * 4 || t < p.r * 0.25) return false;
  const ncx = Ax + t * Nx, ncy = Ay + t * Ny;
  const aA = Math.atan2(Ay - ncy, Ax - ncx);
  const aJ = Math.atan2(Jy - ncy, Jx - ncx);
  const startA = atStart ? aJ : aA;
  const endA = atStart ? aA : aJ;
  const spanCCW = ccwSpan(startA, endA);
  const sweep = p.ccw ? spanCCW : 2 * Math.PI - spanCCW;
  if (!(sweep > 0) || sweep > MAX_SWEEP) return false;
  if (Math.abs(sweep - p.sweep) > 0.35) return false;
  p.cx = ncx;
  p.cy = ncy;
  p.r = t;
  p.startAngle = startA;
  p.endAngle = endA;
  p.sweep = sweep;
  return true;
}
function joinArcsExactly(a0, a1, maxMove = ARC_JOIN_MAX_MOVE) {
  const E0 = primitiveEndPoint(a0, false);
  const E1 = primitiveEndPoint(a1, true);
  const mx = (E0.x + E1.x) * 0.5, my = (E0.y + E1.y) * 0.5;
  const xs = circleCircleIntersect(a0.cx, a0.cy, a0.r, a1.cx, a1.cy, a1.r);
  if (xs) {
    const d0 = Math.hypot(xs[0].x - mx, xs[0].y - my);
    const d1 = Math.hypot(xs[1].x - mx, xs[1].y - my);
    if (Math.min(d0, d1) <= maxMove) {
      const near = d0 <= d1 ? xs[0] : xs[1];
      const s0 = { s: a0.startAngle, e: a0.endAngle, w: a0.sweep };
      if (snapArcAngle(a0, Math.atan2(near.y - a0.cy, near.x - a0.cx), false)) {
        if (snapArcAngle(a1, Math.atan2(near.y - a1.cy, near.x - a1.cx), true)) return true;
        a0.startAngle = s0.s;
        a0.endAngle = s0.e;
        a0.sweep = s0.w;
      }
    }
  }
  const b0 = { cx: a0.cx, cy: a0.cy, r: a0.r, s: a0.startAngle, e: a0.endAngle, w: a0.sweep };
  if (reanchorArcThrough(
    a0,
    mx,
    my,
    /*atStart=*/
    false
  )) {
    if (reanchorArcThrough(
      a1,
      mx,
      my,
      /*atStart=*/
      true
    )) return true;
    a0.cx = b0.cx;
    a0.cy = b0.cy;
    a0.r = b0.r;
    a0.startAngle = b0.s;
    a0.endAngle = b0.e;
    a0.sweep = b0.w;
  }
  if (reanchorArcThrough(
    a1,
    E0.x,
    E0.y,
    /*atStart=*/
    true
  )) return true;
  if (reanchorArcThrough(
    a0,
    E1.x,
    E1.y,
    /*atStart=*/
    false
  )) return true;
  return false;
}
function lineArcJunction(lx1, ly1, lx2, ly2, cx, cy, r, tRef, maxDev) {
  const dx = lx2 - lx1, dy = ly2 - ly1;
  const ts = lineCircleTs(lx1, ly1, dx, dy, cx, cy, r);
  if (ts.length === 0) return null;
  const t = Math.abs(ts[0] - tRef) <= Math.abs(ts[1] - tRef) ? ts[0] : ts[1];
  if (Math.abs(t - tRef) > maxDev) return null;
  return { x: lx1 + t * dx, y: ly1 + t * dy, t };
}
var MAX_JOINT_CONNECTOR_PX = 12;
var bridgeable = (a, b) => {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return d > 1e-6 && d <= MAX_JOINT_CONNECTOR_PX;
};
function lineArcFallback(anchorX, anchorY, movingX, movingY, arcEnd2) {
  const dx = movingX - anchorX, dy = movingY - anchorY;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return { x: arcEnd2.x, y: arcEnd2.y };
  const ux = dx / len, uy = dy / len;
  const t = (arcEnd2.x - anchorX) * ux + (arcEnd2.y - anchorY) * uy;
  return { x: anchorX + t * ux, y: anchorY + t * uy };
}
function snapAdjacentJunctions(segs) {
  const pending = [];
  for (let i = 0; i + 1 < segs.length; i++) {
    const p0 = segs[i].prim;
    const p1 = segs[i + 1].prim;
    const E0 = primitiveEndPoint(p0, false);
    const E1 = primitiveEndPoint(p1, true);
    if (p0.type === "arc" && p1.type === "line") {
      const j = lineArcJunction(
        p1.x1,
        p1.y1,
        p1.x2,
        p1.y2,
        p0.cx,
        p0.cy,
        p0.r,
        0,
        2
      );
      if (j) {
        p1.x1 = j.x;
        p1.y1 = j.y;
        snapArcAngle(p0, Math.atan2(j.y - p0.cy, j.x - p0.cx), false);
      } else if (bridgeable(E0, E1)) {
        pending.push({ afterIdx: i, prim: makeLinePrimitive(E0.x, E0.y, E1.x, E1.y) });
      } else {
        const J = lineArcFallback(p1.x2, p1.y2, p1.x1, p1.y1, E0);
        p1.x1 = J.x;
        p1.y1 = J.y;
        if (!reanchorArcThrough(p0, J.x, J.y, false)) {
          snapArcAngle(p0, Math.atan2(J.y - p0.cy, J.x - p0.cx), false);
        }
      }
    } else if (p0.type === "line" && p1.type === "arc") {
      const j = lineArcJunction(
        p0.x1,
        p0.y1,
        p0.x2,
        p0.y2,
        p1.cx,
        p1.cy,
        p1.r,
        1,
        2
      );
      if (j) {
        p0.x2 = j.x;
        p0.y2 = j.y;
        snapArcAngle(p1, Math.atan2(j.y - p1.cy, j.x - p1.cx), true);
      } else if (bridgeable(E0, E1)) {
        pending.push({ afterIdx: i, prim: makeLinePrimitive(E0.x, E0.y, E1.x, E1.y) });
      } else {
        const J = lineArcFallback(p0.x1, p0.y1, p0.x2, p0.y2, E1);
        p0.x2 = J.x;
        p0.y2 = J.y;
        if (!reanchorArcThrough(p1, J.x, J.y, true)) {
          snapArcAngle(p1, Math.atan2(J.y - p1.cy, J.x - p1.cx), true);
        }
      }
    } else if (p0.type === "line" && p1.type === "line") {
      const dx0 = p0.x2 - p0.x1;
      const dy0 = p0.y2 - p0.y1;
      const dx1 = p1.x2 - p1.x1;
      const dy1 = p1.y2 - p1.y1;
      const len0 = Math.hypot(dx0, dy0), len1 = Math.hypot(dx1, dy1);
      let Jx, Jy;
      const cross = Math.abs(dx0 * dy1 - dy0 * dx1);
      const MIN_SIN = 0.035;
      const ix = cross >= MIN_SIN * len0 * len1 ? lineLineIntersect(
        p0.x1,
        p0.y1,
        dx0,
        dy0,
        p1.x1,
        p1.y1,
        dx1,
        dy1
      ) : null;
      const gapDist = Math.hypot(E1.x - E0.x, E1.y - E0.y);
      const maxMove = 3 * gapDist + 10;
      if (ix !== null && Math.hypot(ix.x - E0.x, ix.y - E0.y) <= maxMove && Math.hypot(ix.x - E1.x, ix.y - E1.y) <= maxMove) {
        Jx = ix.x;
        Jy = ix.y;
      } else {
        const mx = (E0.x + E1.x) * 0.5, my = (E0.y + E1.y) * 0.5;
        const f0 = segs[i].frozen === true, f1 = segs[i + 1].frozen === true;
        const onAxis = (p, dx, dy, len) => {
          const t = ((mx - p.x1) * dx + (my - p.y1) * dy) / (len * len);
          return { x: p.x1 + t * dx, y: p.y1 + t * dy };
        };
        let J = { x: mx, y: my };
        if (f0 && !f1 && len0 > 1e-9) J = onAxis(p0, dx0, dy0, len0);
        else if (f1 && !f0 && len1 > 1e-9) J = onAxis(p1, dx1, dy1, len1);
        Jx = J.x;
        Jy = J.y;
      }
      p0.x2 = Jx;
      p0.y2 = Jy;
      p1.x1 = Jx;
      p1.y1 = Jy;
    } else {
      const a0 = p0, a1 = p1;
      if (!joinArcsExactly(a0, a1)) {
        const Jx = (E0.x + E1.x) * 0.5, Jy = (E0.y + E1.y) * 0.5;
        snapArcAngle(a0, Math.atan2(Jy - a0.cy, Jx - a0.cx), false);
        snapArcAngle(a1, Math.atan2(Jy - a1.cy, Jx - a1.cx), true);
      }
    }
  }
  const inserted = [];
  for (let k = pending.length - 1; k >= 0; k--) {
    const { afterIdx, prim } = pending[k];
    const w = segs[afterIdx].wj;
    segs.splice(afterIdx + 1, 0, { wi: w, wj: w, prim });
    for (let m = 0; m < inserted.length; m++) inserted[m]++;
    inserted.push(afterIdx + 1);
  }
  return inserted;
}

// src/gpu/snap_endpoint_pairs.ts
var MAX_MERGE_DEVIATION = 0.25;
function snapEndpointPairs(graph, chainInfos, reconByChain, maxExtend) {
  const { vertices } = graph;
  const eps = [];
  for (let ci = 0; ci < chainInfos.length; ci++) {
    const recon = reconByChain[ci];
    if (!recon || recon.length === 0) continue;
    const info = chainInfos[ci];
    if (info.isClosed) continue;
    const startVi = info.startVi;
    const endVi = info.endVi;
    const layer = info.layer;
    if (vertices[startVi]?.type === "endpoint") {
      const p = recon[0].prim;
      if (p.type === "line")
        eps.push({ prim: p, isStart: true, ci, layer });
    }
    if (vertices[endVi]?.type === "endpoint") {
      const p = recon[recon.length - 1].prim;
      if (p.type === "line")
        eps.push({ prim: p, isStart: false, ci, layer });
    }
  }
  for (let i = 0; i < eps.length; i++) {
    for (let j = i + 1; j < eps.length; j++) {
      const a = eps[i], b = eps[j];
      if (a.layer !== void 0 && b.layer !== void 0 && a.layer !== b.layer) continue;
      const ax = a.isStart ? a.prim.x1 : a.prim.x2, ay = a.isStart ? a.prim.y1 : a.prim.y2;
      const bx = b.isStart ? b.prim.x1 : b.prim.x2, by = b.isStart ? b.prim.y1 : b.prim.y2;
      if (Math.hypot(bx - ax, by - ay) > maxExtend * 2) continue;
      const adx = a.isStart ? a.prim.x1 - a.prim.x2 : a.prim.x2 - a.prim.x1;
      const ady = a.isStart ? a.prim.y1 - a.prim.y2 : a.prim.y2 - a.prim.y1;
      const bdx = b.isStart ? b.prim.x1 - b.prim.x2 : b.prim.x2 - b.prim.x1;
      const bdy = b.isStart ? b.prim.y1 - b.prim.y2 : b.prim.y2 - b.prim.y1;
      const gx = bx - ax, gy = by - ay;
      const dotA = adx * gx + ady * gy;
      const dotB = -bdx * gx - bdy * gy;
      if (dotA <= 0 || dotB <= 0) continue;
      const adLen = Math.hypot(adx, ady);
      const bdLen = Math.hypot(bdx, bdy);
      const denom = adx * bdy - ady * bdx;
      const sinTheta = Math.abs(denom) / (adLen * bdLen);
      if (sinTheta < 0.1) {
        const bxFar = b.isStart ? b.prim.x2 : b.prim.x1;
        const byFar = b.isStart ? b.prim.y2 : b.prim.y1;
        const axFar = a.isStart ? a.prim.x2 : a.prim.x1;
        const ayFar = a.isStart ? a.prim.y2 : a.prim.y1;
        const jx = (ax + bx) * 0.5, jy = (ay + by) * 0.5;
        const mdx = bxFar - axFar, mdy = byFar - ayFar;
        const mLen = Math.hypot(mdx, mdy);
        if (mLen > 1e-9) {
          const dev = Math.abs((jx - axFar) * mdy - (jy - ayFar) * mdx) / mLen;
          if (dev > MAX_MERGE_DEVIATION) continue;
        }
        if (a.isStart) {
          a.prim.x1 = bxFar;
          a.prim.y1 = byFar;
        } else {
          a.prim.x2 = bxFar;
          a.prim.y2 = byFar;
        }
        const reconB = reconByChain[b.ci];
        if (reconB) {
          if (b.isStart) reconB.shift();
          else reconB.pop();
        }
      } else {
        const t = (gx * bdy - gy * bdx) / denom;
        const ix = ax + t * adx;
        const iy = ay + t * ady;
        if (Math.hypot(ix - ax, iy - ay) > maxExtend) continue;
        if (Math.hypot(ix - bx, iy - by) > maxExtend) continue;
        if (a.isStart) {
          a.prim.x1 = ix;
          a.prim.y1 = iy;
        } else {
          a.prim.x2 = ix;
          a.prim.y2 = iy;
        }
        if (b.isStart) {
          b.prim.x1 = ix;
          b.prim.y1 = iy;
        } else {
          b.prim.x2 = ix;
          b.prim.y2 = iy;
        }
      }
    }
  }
}

// src/gpu/curve_fit.ts
function buildAdj(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  for (const e of edges) {
    adj[e.from].push(e.to);
    adj[e.to].push(e.from);
  }
  return adj;
}
function extractChains(graph) {
  const { vertices, edges } = graph;
  const n = vertices.length;
  const adj = buildAdj(n, edges);
  const chains = [];
  const edgeVisited = /* @__PURE__ */ new Set();
  function edgeKey(a, b) {
    return a < b ? `${a},${b}` : `${b},${a}`;
  }
  for (let start = 0; start < n; start++) {
    if (vertices[start].type === "chain") continue;
    for (const next of adj[start]) {
      const key = edgeKey(start, next);
      if (edgeVisited.has(key)) continue;
      const path = [start, next];
      edgeVisited.add(key);
      let prev = start, curr = next;
      while (vertices[curr].type === "chain") {
        const nextN = adj[curr].find((x) => x !== prev);
        if (nextN === void 0) break;
        const nk = edgeKey(curr, nextN);
        if (edgeVisited.has(nk)) break;
        edgeVisited.add(nk);
        path.push(nextN);
        prev = curr;
        curr = nextN;
      }
      const layer = vertices[path[0]].layer ?? vertices[path[1]].layer;
      chains.push({ vertices: path, layer, isClosed: false });
    }
  }
  const inRing = new Uint8Array(n);
  for (const ch of chains) {
    for (const vi of ch.vertices) inRing[vi] = 1;
  }
  for (let start = 0; start < n; start++) {
    if (inRing[start] || vertices[start].type !== "chain") continue;
    const ring = [start];
    inRing[start] = 1;
    let prev = -1, curr = start;
    while (true) {
      const nextN = adj[curr].find((x) => x !== prev && !inRing[x]);
      if (nextN === void 0) break;
      inRing[nextN] = 1;
      ring.push(nextN);
      prev = curr;
      curr = nextN;
    }
    if (ring.length >= 3) {
      chains.push({ vertices: ring, layer: vertices[ring[0]].layer, isClosed: true });
    }
  }
  return chains;
}
function appendStrokeMarks(curves, marks) {
  if (marks.length === 0) return;
  let nextChain = 0;
  for (const s of curves.segments) nextChain = Math.max(nextChain, s.chainId + 1);
  for (const m of marks) {
    curves.segments.push({
      layer: m.layer,
      chainId: nextChain++,
      isClosed: false,
      primitive: makeLinePrimitive(m.x1, m.y1, m.x2, m.y2)
    });
  }
}
async function readInkProbe(device, decomp) {
  const { width, height, rowStride, layers } = decomp;
  if (decomp.cpuWords) {
    return inkProbeFromWords(decomp.cpuWords, width, height, rowStride);
  }
  if (!device) throw new Error("readInkProbe: no GPU device and no cpuWords fallback");
  const totalBytes = layers.length * rowStride * height * 4;
  const staging = device.createBuffer({
    size: totalBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(decomp.buffer, 0, staging, 0, totalBytes);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const words = new Uint32Array(staging.getMappedRange().slice(0));
  staging.unmap();
  staging.destroy();
  return inkProbeFromWords(words, width, height, rowStride);
}
async function readAllLayers(device, decomp) {
  const { width, height, rowStride, layers } = decomp;
  const numLayers = layers.length;
  const layerWords = rowStride * height;
  const layerBytes = layerWords * 4;
  const totalBytes = numLayers * layerBytes;
  if (decomp.cpuWords) {
    const allWords2 = decomp.cpuWords;
    const result2 = [];
    for (let li = 0; li < numLayers; li++) {
      const offset = li * layerWords;
      const pixels = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const wordIdx = offset + y * rowStride + (x >>> 5);
          if (allWords2[wordIdx] >>> (x & 31) & 1) {
            pixels[y * width + x] = 1;
          }
        }
      }
      result2.push(pixels);
    }
    return result2;
  }
  if (!device) {
    throw new Error("readAllLayers: no GPU device and no cpuWords fallback");
  }
  const staging = device.createBuffer({
    size: totalBytes,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(decomp.buffer, 0, staging, 0, totalBytes);
  device.queue.submit([encoder.finish()]);
  await staging.mapAsync(GPUMapMode.READ);
  const allWords = new Uint32Array(staging.getMappedRange());
  const result = [];
  for (let li = 0; li < numLayers; li++) {
    const offset = li * layerWords;
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const wordIdx = offset + y * rowStride + (x >>> 5);
        if (allWords[wordIdx] >>> (x & 31) & 1) {
          pixels[y * width + x] = 1;
        }
      }
    }
    result.push(pixels);
  }
  staging.unmap();
  staging.destroy();
  return result;
}
var DEFAULT_MAX_SEG_VERTS = 256;
var DEFAULT_SPECK_MAX_PX = 8;
function fitDenseChain(wdv, wpverts, wvs, opts) {
  const W = wdv.length;
  const MIN_SEG = 4;
  if (W < MIN_SEG) return [];
  const centX = new Float64Array(W);
  const centY = new Float64Array(W);
  const validV = new Uint8Array(W);
  for (let vi = 0; vi < W; vi++) {
    const pxs = wpverts[vi];
    if (pxs.length >= 2) {
      let sx = 0, sy = 0;
      for (const p of pxs) {
        sx += p.x;
        sy += p.y;
      }
      centX[vi] = sx / pxs.length;
      centY[vi] = sy / pxs.length;
      validV[vi] = 1;
    } else {
      centX[vi] = wdv[vi].x;
      centY[vi] = wdv[vi].y;
    }
  }
  const dirOut = new Float64Array(5);
  const pxN = new Int32Array(W);
  for (let vi = 0; vi < W; vi++) pxN[vi] = wpverts[vi].length;
  let probeLo = 0, probeHi = 0;
  const probe = (c) => {
    let sum = 0, cnt = 0;
    for (let k = Math.max(probeLo, c - 1); k <= Math.min(probeHi, c + 1); k++) {
      sum += pxN[k];
      cnt++;
    }
    return cnt > 0 ? sum / cnt : 0;
  };
  const MDL = opts.mdlPenalty;
  const INF = Infinity;
  const dpCost = new Float64Array(W + 1).fill(INF);
  const dpFrom = new Int32Array(W + 1).fill(-1);
  const dpPrim = new Array(W + 1).fill(null);
  const dpCE = new Float64Array(W + 1);
  dpCost[0] = 0;
  const minArcVerts = 6;
  const ARC_CE_SAMPLES = 24;
  const MAX_SEG_VERTS = DEFAULT_MAX_SEG_VERTS;
  let fitArcs = opts.fitArcs !== false;
  if (fitArcs && W >= 2) {
    const ax = wdv[0].x, ay = wdv[0].y;
    const cdx = wdv[W - 1].x - ax, cdy = wdv[W - 1].y - ay;
    const cl = Math.hypot(cdx, cdy);
    if (cl > 1e-6) {
      let curvy = false;
      for (let i = 1; i < W - 1; i++) {
        const d = Math.abs((wdv[i].x - ax) * cdy - (wdv[i].y - ay) * cdx) / cl;
        if (d >= 1.5) {
          curvy = true;
          break;
        }
      }
      fitArcs = curvy;
    }
  }
  for (let wi = 0; wi < W; wi++) {
    if (dpCost[wi] === INF) continue;
    let pxCount = 0;
    const win = new Float64Array(6);
    let vN = 0, vSX = 0, vSY = 0, vSX2 = 0, vSY2 = 0, vSXY = 0;
    let gN = 0, gSX = 0, gSY = 0, gSX2 = 0, gSY2 = 0, gSXY = 0;
    const sx0 = centX[wi], sy0 = centY[wi];
    let aSx = 0, aSy = 0, aSxx = 0, aSyy = 0, aSxy = 0;
    let aSxxx = 0, aSyyy = 0, aSxxy = 0, aSxyy = 0;
    const wjEnd = Math.min(W, wi + MAX_SEG_VERTS);
    for (let wj = wi; wj < wjEnd; wj++) {
      windowAdd(win, wvs, wj);
      pxCount += pxN[wj];
      const cxj = centX[wj], cyj = centY[wj];
      if (!validV[wj]) {
        gN++;
        gSX += cxj;
        gSY += cyj;
        gSX2 += cxj * cxj;
        gSY2 += cyj * cyj;
        gSXY += cxj * cyj;
      }
      if (validV[wj]) {
        vN++;
        vSX += cxj;
        vSY += cyj;
        vSX2 += cxj * cxj;
        vSY2 += cyj * cyj;
        vSXY += cxj * cyj;
        if (fitArcs) {
          const u = cxj - sx0, v = cyj - sy0;
          aSx += u;
          aSy += v;
          aSxx += u * u;
          aSyy += v * v;
          aSxy += u * v;
          aSxxx += u * u * u;
          aSyyy += v * v * v;
          aSxxy += u * u * v;
          aSxyy += u * v * v;
        }
      }
      const nv = wj - wi + 1;
      if (nv < MIN_SEG) continue;
      const usePixels = pxCount >= opts.minPoints;
      dirFromWindowInto(win, dirOut);
      let dirX = dirOut[0], dirY = dirOut[1], lcx = dirOut[2], lcy = dirOut[3];
      if (!usePixels && gN >= 2) {
        const mx = gSX / gN, my = gSY / gN;
        const Cxx = gSX2 / gN - mx * mx;
        const Cyy = gSY2 / gN - my * my;
        const Cxy = gSXY / gN - mx * my;
        const th = 0.5 * Math.atan2(2 * Cxy, Cxx - Cyy);
        dirX = Math.cos(th);
        dirY = Math.sin(th);
        lcx = mx;
        lcy = my;
      }
      const perpX = -dirY, perpY = dirX;
      const rmsAbout = (n, sx, sy, sxx, syy, sxy) => {
        const Vxx = sxx / n - 2 * lcx * (sx / n) + lcx * lcx;
        const Vyy = syy / n - 2 * lcy * (sy / n) + lcy * lcy;
        const Vxy = sxy / n - lcx * (sy / n) - lcy * (sx / n) + lcx * lcy;
        return Math.sqrt(Math.max(
          0,
          perpX * perpX * Vxx + 2 * perpX * perpY * Vxy + perpY * perpY * Vyy
        ));
      };
      let lineCE = 0;
      if (usePixels && vN >= 2) {
        lineCE = rmsAbout(vN, vSX, vSY, vSX2, vSY2, vSXY);
      }
      const UNSUPPORTED_SLACK_PX = 2;
      const gapCE = gN >= 2 ? Math.max(0, rmsAbout(gN, gSX, gSY, gSX2, gSY2, gSXY) - UNSUPPORTED_SLACK_PX) : 0;
      let bestCE = lineCE;
      let arcHit = false;
      let aCx = 0, aCy = 0, aR = 0, aSa = 0, aEa = 0, aCCW = false, aSweep = 0, aCE = 0;
      arcAttempt:
        if (fitArcs && usePixels && vN >= minArcVerts && lineCE >= 0.1) {
          const ax = centX[wi], ay = centY[wi];
          const bx = centX[wj], by = centY[wj];
          const chordDx = bx - ax, chordDy = by - ay;
          const chordLen = Math.hypot(chordDx, chordDy);
          if (chordLen < 1e-6) break arcAttempt;
          const cnx = -chordDy / chordLen, cny = chordDx / chordLen;
          const netBow = (vSX / vN - ax) * cnx + (vSY / vN - ay) * cny;
          const midVi = wi + wj >> 1;
          const midBow = (centX[midVi] - ax) * cnx + (centY[midVi] - ay) * cny;
          if (Math.abs(netBow) < 0.6 * lineCE) break arcAttempt;
          if (midBow * netBow <= 0 || Math.abs(midBow) < 0.5 * Math.abs(netBow)) break arcAttempt;
          probeLo = wi;
          probeHi = wj;
          const w0 = probe(wi);
          const wq = probe(wi + (wj - wi >> 2));
          const wm = probe(midVi);
          const w3 = probe(wi + (3 * (wj - wi) >> 2));
          const w1 = probe(wj);
          const wMin = Math.max(1, Math.min(w0, wq, wm, w3, w1));
          const wMax = Math.max(w0, wq, wm, w3, w1);
          if (wMax / wMin > 1.5) break arcAttempt;
          const mx = aSx / vN, my = aSy / vN;
          const Mxx = aSxx / vN - mx * mx;
          const Myy = aSyy / vN - my * my;
          const Mxy = aSxy / vN - mx * my;
          const det = Mxx * Myy - Mxy * Mxy;
          if (Math.abs(det) < 1e-10) break arcAttempt;
          const Exxx = aSxxx / vN, Exyy = aSxyy / vN, Exxy = aSxxy / vN, Eyyy = aSyyy / vN;
          const Exx = aSxx / vN, Eyy = aSyy / vN, Exy = aSxy / vN;
          const Mxz = Exxx - 3 * mx * Exx + 2 * mx * mx * mx + (Exyy - 2 * my * Exy - mx * Eyy + 2 * mx * my * my);
          const Myz = Eyyy - 3 * my * Eyy + 2 * my * my * my + (Exxy - 2 * mx * Exy - my * Exx + 2 * my * mx * mx);
          const ocx = (Mxz * Myy - Myz * Mxy) / (2 * det);
          const ocy = (Myz * Mxx - Mxz * Mxy) / (2 * det);
          const r2 = ocx * ocx + ocy * ocy + Mxx + Myy;
          if (!(r2 > 0)) break arcAttempt;
          const r = Math.sqrt(r2);
          const ccx = ocx + mx + sx0;
          const ccy = ocy + my + sy0;
          if (r < opts.minArcRadius || r > chordLen * 10) break arcAttempt;
          const sa = Math.atan2(ay - ccy, ax - ccx);
          const ea = Math.atan2(by - ccy, bx - ccx);
          const pma = Math.atan2(centY[midVi] - ccy, centX[midVi] - ccx);
          const spanCCW = ccwSpan(sa, ea);
          const midCCW = ccwSpan(sa, pma);
          const arcCCW = midCCW < spanCCW;
          const arcSweep = arcCCW ? spanCCW : 2 * Math.PI - spanCCW;
          if (arcSweep <= 0.02 || arcSweep > Math.PI) break arcAttempt;
          const sagitta = r * (1 - Math.cos(arcSweep / 2));
          if (sagitta < 1.5) break arcAttempt;
          const step = Math.max(1, Math.floor(nv / ARC_CE_SAMPLES));
          let ceSum = 0, ceN = 0;
          for (let k = wi; k <= wj; k += step) {
            if (!validV[k]) continue;
            const d = Math.hypot(centX[k] - ccx, centY[k] - ccy) - r;
            ceSum += d * d;
            ceN++;
          }
          if (ceN < 3) break arcAttempt;
          const arcCE = Math.sqrt(ceSum / ceN);
          if (arcCE <= lineCE * opts.arcBenefit && lineCE - arcCE >= 0.05) {
            arcHit = true;
            aCx = ccx;
            aCy = ccy;
            aR = r;
            aSa = sa;
            aEa = ea;
            aCCW = arcCCW;
            aSweep = arcSweep;
            aCE = arcCE;
            bestCE = arcCE;
          }
        }
      const totalCost = dpCost[wi] + bestCE * nv + gapCE * gN + MDL;
      if (totalCost < dpCost[wj + 1]) {
        const tVi = (wdv[wi].x - lcx) * dirX + (wdv[wi].y - lcy) * dirY;
        const tVj = (wdv[wj].x - lcx) * dirX + (wdv[wj].y - lcy) * dirY;
        dpCost[wj + 1] = totalCost;
        dpFrom[wj + 1] = wi;
        dpPrim[wj + 1] = arcHit ? makeArcPrimitive(
          { rmsError: aCE, cx: aCx, cy: aCy, r: aR, valid: true },
          aSa,
          aEa,
          aCCW,
          aSweep
        ) : makeLinePrimitive(
          lcx + tVi * dirX,
          lcy + tVi * dirY,
          lcx + tVj * dirX,
          lcy + tVj * dirY
        );
        dpCE[wj + 1] = bestCE;
      }
    }
  }
  let coverEnd = W;
  while (coverEnd > 0 && dpCost[coverEnd] === INF) coverEnd--;
  if (coverEnd === 0) return [];
  const recon = [];
  {
    let j = coverEnd;
    while (j > 0) {
      const i = dpFrom[j];
      if (i < 0) break;
      recon.unshift({ wi: i, wj: j - 1, prim: dpPrim[j], ce: dpCE[j] });
      j = i;
    }
  }
  return recon;
}
function closeChainSeam(recon, maxExtend) {
  if (recon.length < 2) return;
  const first = recon[0].prim;
  const last = recon[recon.length - 1].prim;
  if (first.type !== "line" || last.type !== "line") return;
  const dax = first.x2 - first.x1, day = first.y2 - first.y1;
  const dbx = last.x2 - last.x1, dby = last.y2 - last.y1;
  const cross = dax * dby - day * dbx;
  if (Math.abs(cross) < 1e-10) return;
  const dx = last.x1 - first.x1, dy = last.y1 - first.y1;
  const s = (dx * dby - dy * dbx) / cross;
  if (s > 0) return;
  const ix = first.x1 + s * dax;
  const iy = first.y1 + s * day;
  if (Math.hypot(ix - first.x1, iy - first.y1) > maxExtend) return;
  if (Math.hypot(ix - last.x2, iy - last.y2) > maxExtend) return;
  first.x1 = ix;
  first.y1 = iy;
  last.x2 = ix;
  last.y2 = iy;
}
function snapJunctionEndpoints(graph, chainInfos, reconByChain, maxExtend, stubMaxPx = 0) {
  const { vertices } = graph;
  const MAX_PIVOT_PX = 0.8;
  const jmap = /* @__PURE__ */ new Map();
  const entryPoint = (e) => primitiveEndPoint(e.prim, e.isStart);
  for (let ci = 0; ci < chainInfos.length; ci++) {
    const recon = reconByChain[ci];
    if (!recon || recon.length === 0) continue;
    const info = chainInfos[ci];
    if (info.isClosed) continue;
    const startVi = info.startVi;
    const endVi = info.endVi;
    if (vertices[startVi]?.type === "junction") {
      let mi = 0;
      while (mi + 1 < recon.length && stubMaxPx > 0) {
        const p = recon[mi].prim;
        if (p.type !== "line" || Math.hypot(p.x2 - p.x1, p.y2 - p.y1) >= stubMaxPx) break;
        mi++;
      }
      const e = jmap.get(startVi) ?? [];
      e.push({ prim: recon[mi].prim, isStart: true, ci, mainIdx: mi });
      jmap.set(startVi, e);
    }
    if (vertices[endVi]?.type === "junction") {
      let mi = recon.length - 1;
      while (mi - 1 >= 0 && stubMaxPx > 0) {
        const p = recon[mi].prim;
        if (p.type !== "line" || Math.hypot(p.x2 - p.x1, p.y2 - p.y1) >= stubMaxPx) break;
        mi--;
      }
      const e = jmap.get(endVi) ?? [];
      e.push({ prim: recon[mi].prim, isStart: false, ci, mainIdx: mi });
      jmap.set(endVi, e);
    }
  }
  const pendingConnectors = [];
  for (const [, entries] of jmap.entries()) {
    if (entries.length < 2) continue;
    let sx = 0, sy = 0;
    for (const e of entries) {
      const q = entryPoint(e);
      sx += q.x;
      sy += q.y;
    }
    const mxp = sx / entries.length, myp = sy / entries.length;
    let spread = 0;
    for (const a of entries) {
      const qa = entryPoint(a);
      for (const b of entries) {
        const qb = entryPoint(b);
        spread = Math.max(spread, Math.hypot(qa.x - qb.x, qa.y - qb.y));
      }
    }
    let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
    for (const e of entries) {
      const q = entryPoint(e);
      const t = primitiveTangentAt(e.prim, e.isStart);
      const nx = -t.ty, ny = t.tx;
      const c = nx * q.x + ny * q.y;
      a00 += nx * nx;
      a01 += nx * ny;
      a11 += ny * ny;
      b0 += c * nx;
      b1 += c * ny;
    }
    const det = a00 * a11 - a01 * a01;
    let jx = mxp, jy = myp;
    if (Math.abs(det) >= 1e-3 * Math.max(1, a00 + a11)) {
      const ix = (a11 * b0 - a01 * b1) / det;
      const iy = (a00 * b1 - a01 * b0) / det;
      const near = Math.hypot(ix - mxp, iy - myp) <= 2 * spread + 4;
      let reachable = true;
      for (const e of entries) {
        const q = entryPoint(e);
        if (Math.hypot(ix - q.x, iy - q.y) > maxExtend) {
          reachable = false;
          break;
        }
      }
      if (near && reachable) {
        jx = ix;
        jy = iy;
      }
    }
    for (const { prim, isStart, ci, mainIdx } of entries) {
      const recon = reconByChain[ci];
      let connector = null;
      if (prim.type === "line") {
        const dx = prim.x2 - prim.x1, dy = prim.y2 - prim.y1;
        const len = Math.hypot(dx, dy);
        const off = len > 1e-9 ? Math.abs((jx - prim.x1) * dy - (jy - prim.y1) * dx) / len : Infinity;
        if (!(off > MAX_PIVOT_PX) || len < 8 * off) {
          if (isStart) {
            prim.x1 = jx;
            prim.y1 = jy;
          } else {
            prim.x2 = jx;
            prim.y2 = jy;
          }
        } else {
          const ux = dx / len, uy = dy / len;
          const inward = isStart ? 1 : -1;
          const t = (jx - prim.x1) * ux + (jy - prim.y1) * uy + inward * off;
          const px = prim.x1 + t * ux, py = prim.y1 + t * uy;
          if (isStart) {
            prim.x1 = px;
            prim.y1 = py;
            connector = makeLinePrimitive(jx, jy, px, py);
          } else {
            prim.x2 = px;
            prim.y2 = py;
            connector = makeLinePrimitive(px, py, jx, jy);
          }
        }
      } else if (!reanchorArcThrough(prim, jx, jy, isStart)) {
        continue;
      }
      if (isStart && mainIdx > 0) {
        recon.splice(0, mainIdx);
      } else if (!isStart && mainIdx < recon.length - 1) {
        recon.splice(mainIdx + 1);
      }
      if (connector) pendingConnectors.push({ ci, isStart, prim: connector });
    }
  }
  for (const { ci, isStart, prim } of pendingConnectors) {
    const recon = reconByChain[ci];
    if (!recon || recon.length === 0) continue;
    if (isStart) {
      recon.unshift({ wi: recon[0].wi, wj: recon[0].wi, ce: 0, prim });
    } else {
      const last = recon[recon.length - 1];
      recon.push({ wi: last.wj, wj: last.wj, ce: 0, prim });
    }
  }
}
function recenterOnSkeleton(reconByChain, cache, minVerts, chainInfos, graph) {
  for (let ci = 0; ci < reconByChain.length; ci++) {
    const recon = reconByChain[ci];
    if (!recon || recon.length === 0) continue;
    const ch = cache.chains[ci];
    if (!ch) continue;
    const dv = ch.denseVerts;
    let pinStart = false, pinEnd = false;
    if (chainInfos && graph) {
      const info = chainInfos[ci];
      if (info && !info.isClosed) {
        const sv = graph.vertices[info.startVi];
        const ev = graph.vertices[info.endVi];
        if (sv?.type === "junction") pinStart = true;
        if (ev?.type === "junction") pinEnd = true;
      }
    }
    for (let si = 0; si < recon.length; si++) {
      const s = recon[si];
      const p = s.prim;
      if (p.type !== "line") continue;
      const nv = s.wj - s.wi + 1;
      if (nv < minVerts) continue;
      const isFirstSeg = si === 0;
      const isLastSeg = si === recon.length - 1;
      const pin1 = isFirstSeg && pinStart;
      const pin2 = isLastSeg && pinEnd;
      if (pin1 || pin2) {
        continue;
      }
      const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-10) continue;
      const perpX = -dy / len, perpY = dx / len;
      let sumPerp = 0;
      for (let vi = s.wi; vi <= s.wj; vi++) {
        sumPerp += (dv[vi].x - p.x1) * perpX + (dv[vi].y - p.y1) * perpY;
      }
      const meanPerp = sumPerp / nv;
      p.x1 += meanPerp * perpX;
      p.y1 += meanPerp * perpY;
      p.x2 += meanPerp * perpX;
      p.y2 += meanPerp * perpY;
    }
  }
}
var AXIS_TAN = 0.105;
var AXIS_FLAT_PX = 0.75;
var AXIS_NO_WORSE_PX = 0.35;
function recentreAxisAligned(reconByChain, cache, maxShift) {
  for (let ci = 0; ci < reconByChain.length; ci++) {
    const recon = reconByChain[ci];
    const ch = cache.chains[ci];
    if (!recon || !ch) continue;
    const nv = ch.denseVerts.length;
    for (const s of recon) {
      const p = s.prim;
      if (p.type !== "line") continue;
      const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const horizontal = Math.abs(dy) <= Math.abs(dx) * AXIS_TAN;
      const vertical = Math.abs(dx) <= Math.abs(dy) * AXIS_TAN;
      if (horizontal === vertical) continue;
      const vals = [];
      for (let vi = s.wi; vi <= s.wj && vi < nv; vi++) {
        const pxs = ch.pixelsPerVert[vi];
        if (!pxs || pxs.length < 2) continue;
        let sum = 0;
        for (const px of pxs) sum += horizontal ? px.y : px.x;
        vals.push(sum / pxs.length);
      }
      if (vals.length < 3) continue;
      const sorted = vals.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      const cur = horizontal ? (p.y1 + p.y2) / 2 : (p.x1 + p.x2) / 2;
      if (!(Math.abs(med - cur) <= maxShift)) continue;
      const already = Math.abs(horizontal ? dy : dx) <= 1e-6;
      if (!already) {
        let axisDev = 0;
        for (const v of vals) axisDev = Math.max(axisDev, Math.abs(v - med));
        if (axisDev > AXIS_FLAT_PX) continue;
        let fitDev = 0;
        const px0 = p.x1, py0 = p.y1;
        for (let vi = s.wi, k = 0; vi <= s.wj && vi < nv; vi++) {
          const pxs = ch.pixelsPerVert[vi];
          if (!pxs || pxs.length < 2) continue;
          let sx = 0, sy = 0;
          for (const q of pxs) {
            sx += q.x;
            sy += q.y;
          }
          const cxv = sx / pxs.length, cyv = sy / pxs.length;
          fitDev = Math.max(fitDev, Math.abs((cxv - px0) * dy - (cyv - py0) * dx) / len);
          k++;
        }
        if (axisDev > fitDev + AXIS_NO_WORSE_PX) continue;
      }
      if (horizontal) {
        p.y1 = med;
        p.y2 = med;
      } else {
        p.x1 = med;
        p.x2 = med;
      }
    }
  }
}
function recentreLongLines(reconByChain, cache, minLenPx, maxShift) {
  const MIN_SHIFT_PX = 0.05;
  for (let ci = 0; ci < reconByChain.length; ci++) {
    const recon = reconByChain[ci];
    const ch = cache.chains[ci];
    if (!recon || !ch) continue;
    const nv = ch.denseVerts.length;
    for (const s of recon) {
      const p = s.prim;
      if (p.type !== "line") continue;
      const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
      const len = Math.hypot(dx, dy);
      if (len < minLenPx || s.wi > s.wj) continue;
      const ux = dx / len, uy = dy / len;
      const nx = -uy, ny = ux;
      const offs = [];
      for (let vi = s.wi; vi <= s.wj && vi < nv; vi++) {
        const pxs = ch.pixelsPerVert[vi];
        if (!pxs || pxs.length < 2) continue;
        let sx = 0, sy = 0;
        for (const q of pxs) {
          sx += q.x;
          sy += q.y;
        }
        offs.push((sx / pxs.length - p.x1) * nx + (sy / pxs.length - p.y1) * ny);
      }
      if (offs.length < 3) continue;
      offs.sort((a, b) => a - b);
      const mid = offs.length >> 1;
      const med = offs.length % 2 ? offs[mid] : (offs[mid - 1] + offs[mid]) / 2;
      const shift = Math.abs(med);
      if (shift < MIN_SHIFT_PX || shift > maxShift) continue;
      const before = lineCEFast(ch.vertStats, s.wi, s.wj, p.x1, p.y1, ux, uy);
      const after = lineCEFast(
        ch.vertStats,
        s.wi,
        s.wj,
        p.x1 + med * nx,
        p.y1 + med * ny,
        ux,
        uy
      );
      if (!(after < before)) continue;
      p.x1 += med * nx;
      p.y1 += med * ny;
      p.x2 += med * nx;
      p.y2 += med * ny;
    }
  }
}
function collapseJunctionTapers(graph, chainInfos, reconByChain, maxStubPx, maxParallelSin) {
  const { vertices } = graph;
  const jmap = /* @__PURE__ */ new Map();
  for (let ci = 0; ci < chainInfos.length; ci++) {
    const recon = reconByChain[ci];
    if (!recon || recon.length === 0) continue;
    const info = chainInfos[ci];
    if (info.isClosed) continue;
    if (vertices[info.startVi]?.type === "junction") {
      const list = jmap.get(info.startVi) ?? [];
      list.push({ ci, isStart: true });
      jmap.set(info.startVi, list);
    }
    if (vertices[info.endVi]?.type === "junction") {
      const list = jmap.get(info.endVi) ?? [];
      list.push({ ci, isStart: false });
      jmap.set(info.endVi, list);
    }
  }
  const tipOffLine = (l, px, py) => {
    const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-10) return Infinity;
    return Math.abs((px - l.x1) * dy - (py - l.y1) * dx) / len;
  };
  const MAX_TIP_OFFSET = 1.5;
  for (const [_vi, ends] of jmap.entries()) {
    if (ends.length !== 3) continue;
    let stubK = -1, stubLen = Infinity;
    for (let k = 0; k < 3; k++) {
      const { ci, isStart } = ends[k];
      const farVi = isStart ? chainInfos[ci].endVi : chainInfos[ci].startVi;
      if (vertices[farVi]?.type === "junction") continue;
      const recon = reconByChain[ci];
      let len = 0;
      for (const s of recon) len += reconSegLength(s.prim);
      if (len <= maxStubPx && len < stubLen) {
        stubK = k;
        stubLen = len;
      }
    }
    if (stubK < 0) continue;
    const sideKs = [0, 1, 2].filter((k) => k !== stubK);
    const stub = ends[stubK];
    const stubRecon = reconByChain[stub.ci];
    const side0 = ends[sideKs[0]];
    const side1 = ends[sideKs[1]];
    const sideLen = (se) => {
      const r = reconByChain[se.ci];
      let l = 0;
      for (const s of r) l += reconSegLength(s.prim);
      return l;
    };
    const minSideLen = Math.min(sideLen(side0), sideLen(side1));
    if (stubLen > minSideLen * 0.5) continue;
    if (!stub.isStart && side0.isStart && side1.isStart) {
      const tip = primitiveEndPoint(
        stubRecon[0].prim,
        /*atStart=*/
        true
      );
      const tipX = tip.x;
      const tipY = tip.y;
      const r0 = reconByChain[side0.ci], r1 = reconByChain[side1.ci];
      const p0 = r0[0].prim, p1 = r1[0].prim;
      if (p0.type !== "line" || p1.type !== "line") continue;
      const d0x = p0.x2 - p0.x1, d0y = p0.y2 - p0.y1, d0l = Math.hypot(d0x, d0y);
      const d1x = p1.x2 - p1.x1, d1y = p1.y2 - p1.y1, d1l = Math.hypot(d1x, d1y);
      if (d0l < 1e-10 || d1l < 1e-10) continue;
      if (Math.abs(d0x / d0l * d1y / d1l - d0y / d0l * d1x / d1l) > maxParallelSin) continue;
      if (tipOffLine(p0, tipX, tipY) > MAX_TIP_OFFSET) continue;
      if (tipOffLine(p1, tipX, tipY) > MAX_TIP_OFFSET) continue;
      p0.x1 = tipX;
      p0.y1 = tipY;
      p1.x1 = tipX;
      p1.y1 = tipY;
      reconByChain[stub.ci] = [];
    } else if (stub.isStart && !side0.isStart && !side1.isStart) {
      const tip = primitiveEndPoint(
        stubRecon[stubRecon.length - 1].prim,
        /*atStart=*/
        false
      );
      const tipX = tip.x;
      const tipY = tip.y;
      const r0 = reconByChain[side0.ci], r1 = reconByChain[side1.ci];
      const p0 = r0[r0.length - 1].prim, p1 = r1[r1.length - 1].prim;
      if (p0.type !== "line" || p1.type !== "line") continue;
      const d0x = p0.x2 - p0.x1, d0y = p0.y2 - p0.y1, d0l = Math.hypot(d0x, d0y);
      const d1x = p1.x2 - p1.x1, d1y = p1.y2 - p1.y1, d1l = Math.hypot(d1x, d1y);
      if (d0l < 1e-10 || d1l < 1e-10) continue;
      if (Math.abs(d0x / d0l * d1y / d1l - d0y / d0l * d1x / d1l) > maxParallelSin) continue;
      if (tipOffLine(p0, tipX, tipY) > MAX_TIP_OFFSET) continue;
      if (tipOffLine(p1, tipX, tipY) > MAX_TIP_OFFSET) continue;
      const newWj0 = r0[r0.length - 1].wj;
      r0.push({
        wi: newWj0,
        wj: newWj0,
        ce: 0,
        prim: makeLinePrimitive(p0.x2, p0.y2, tipX, tipY)
      });
      const newWj1 = r1[r1.length - 1].wj;
      r1.push({
        wi: newWj1,
        wj: newWj1,
        ce: 0,
        prim: makeLinePrimitive(p1.x2, p1.y2, tipX, tipY)
      });
      chainInfos[side0.ci].endVi = chainInfos[stub.ci].endVi;
      chainInfos[side1.ci].endVi = chainInfos[stub.ci].endVi;
      reconByChain[stub.ci] = [];
    }
  }
}
function freezeConfidentLines(recon, vertStats, minLenPx, maxCE) {
  for (const s of recon) {
    const p = s.prim;
    if (p.type !== "line") continue;
    const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
    const len = Math.hypot(dx, dy);
    if (len < minLenPx) continue;
    if (s.wi > s.wj) continue;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const offs = [];
    for (let vi = s.wi; vi <= s.wj; vi++) {
      const b = vi * 6, n = vertStats[b];
      if (n < 2) continue;
      offs.push(((vertStats[b + 1] - n * p.x1) * nx + (vertStats[b + 2] - n * p.y1) * ny) / n);
    }
    if (offs.length === 0) continue;
    const sorted = offs.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    const med = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    let sum2 = 0;
    for (const o of offs) sum2 += (o - med) * (o - med);
    const ce = Math.sqrt(sum2 / offs.length);
    if (ce <= maxCE) s.frozen = true;
  }
}
function reconSegLength(prim) {
  if (prim.type === "line") return Math.hypot(prim.x2 - prim.x1, prim.y2 - prim.y1);
  return prim.r * prim.sweep;
}
function mergeClosedChainSeam(recon, denseVerts, vertStats) {
  if (recon.length < 2) return;
  const sLast = recon[recon.length - 1];
  const sFirst = recon[0];
  if (sLast.prim.type !== "line" || sFirst.prim.type !== "line") return;
  const pLast = sLast.prim, pFirst = sFirst.prim;
  const lenLast = Math.hypot(pLast.x2 - pLast.x1, pLast.y2 - pLast.y1);
  const lenFirst = Math.hypot(pFirst.x2 - pFirst.x1, pFirst.y2 - pFirst.y1);
  if (lenLast < 1e-10 || lenFirst < 1e-10) return;
  const crossAbs = Math.abs(
    (pLast.x2 - pLast.x1) * (pFirst.y2 - pFirst.y1) - (pLast.y2 - pLast.y1) * (pFirst.x2 - pFirst.x1)
  );
  if (crossAbs / (lenLast * lenFirst) >= 0.05) return;
  const nVerts = denseVerts.length;
  const allWin = new Float64Array(6);
  for (let vi = sLast.wi; vi < nVerts; vi++) windowAdd(allWin, vertStats, vi);
  for (let vi = 0; vi <= sFirst.wj; vi++) windowAdd(allWin, vertStats, vi);
  let lDirX = 1, lDirY = 0, lCx = 0, lCy = 0;
  if (allWin[0] >= 2) {
    const r = dirFromWindow(allWin);
    lDirX = r.dirX;
    lDirY = r.dirY;
    lCx = r.cx;
    lCy = r.cy;
  } else {
    lCx = (pLast.x1 + pFirst.x2) / 2;
    lCy = (pLast.y1 + pFirst.y2) / 2;
    const ddx = pFirst.x2 - pLast.x1, ddy = pFirst.y2 - pLast.y1;
    const dl = Math.hypot(ddx, ddy);
    if (dl > 1e-10) {
      lDirX = ddx / dl;
      lDirY = ddy / dl;
    }
  }
  const ceLast = lineCEFast(vertStats, sLast.wi, nVerts - 1, lCx, lCy, lDirX, lDirY);
  const ceFirst = lineCEFast(vertStats, sFirst.wi, sFirst.wj, lCx, lCy, lDirX, lDirY);
  const mergedCE = Math.max(ceLast, ceFirst);
  if (mergedCE > Math.max(sLast.ce, sFirst.ce) * 3 + 0.5) return;
  const tStart = (pLast.x1 - lCx) * lDirX + (pLast.y1 - lCy) * lDirY;
  const tEnd = (pFirst.x2 - lCx) * lDirX + (pFirst.y2 - lCy) * lDirY;
  const mergedPrim = makeLinePrimitive(
    lCx + tStart * lDirX,
    lCy + tStart * lDirY,
    lCx + tEnd * lDirX,
    lCy + tEnd * lDirY
  );
  recon[0] = { wi: sLast.wi, wj: sFirst.wj, prim: mergedPrim, ce: mergedCE };
  recon.pop();
}
function mergeCollinearSegments(recon, denseVerts, vertStats, minLengthPx, mdlPenalty = 3, maxCE = 0.5) {
  const FREEZE_OVERRIDE_RATIO = 0.65;
  const FREEZE_OVERRIDE_MIN_PX = 0.05;
  const FREEZE_NO_ROTATION_PX = 0.1;
  const cornerStubMax = minLengthPx * 6;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < recon.length; i++) {
      const s1 = recon[i], s2 = recon[i + 1];
      if (s1.prim.type !== "line" || s2.prim.type !== "line") continue;
      const p1 = s1.prim, p2 = s2.prim;
      const len1 = Math.hypot(p1.x2 - p1.x1, p1.y2 - p1.y1);
      const len2 = Math.hypot(p2.x2 - p2.x1, p2.y2 - p2.y1);
      let shortAbsorb = false;
      if (len1 >= minLengthPx && len2 >= minLengthPx) {
        const SHORT_ABSORB = minLengthPx * 10;
        shortAbsorb = Math.min(len1, len2) < SHORT_ABSORB;
        const sinLimit = shortAbsorb ? 0.1 : 0.02;
        const crossAbs = Math.abs(
          (p1.x2 - p1.x1) * (p2.y2 - p2.y1) - (p1.y2 - p1.y1) * (p2.x2 - p2.x1)
        );
        const sinAng = crossAbs / (len1 * len2);
        const MAX_KINK_PX = 2.5;
        const KINK_MAX_SIN = 0.26;
        const kinkPx = Math.min(len1, len2) * sinAng;
        if (sinAng >= sinLimit && (sinAng > KINK_MAX_SIN || kinkPx > MAX_KINK_PX)) continue;
      }
      const allWin = new Float64Array(6);
      for (let vi = s1.wi; vi <= s2.wj; vi++) windowAdd(allWin, vertStats, vi);
      let lDirX = 1, lDirY = 0, lCx = 0, lCy = 0;
      if (allWin[0] >= 2) {
        const r = dirFromWindow(allWin);
        lDirX = r.dirX;
        lDirY = r.dirY;
        lCx = r.cx;
        lCy = r.cy;
      } else {
        const v0 = denseVerts[s1.wi], v1 = denseVerts[s2.wj];
        lCx = (v0.x + v1.x) / 2;
        lCy = (v0.y + v1.y) / 2;
        const ddx = v1.x - v0.x, ddy = v1.y - v0.y;
        const dl = Math.hypot(ddx, ddy);
        if (dl > 1e-10) {
          lDirX = ddx / dl;
          lDirY = ddy / dl;
        }
      }
      const QUANT_FLOOR = 0.25;
      const LATERAL_SHIFT_MAX = 1;
      const vStart = denseVerts[s1.wi], vEnd = denseVerts[s2.wj];
      const mergedCE = lineCEFast(
        vertStats,
        s1.wi,
        s2.wj,
        lCx,
        lCy,
        lDirX,
        lDirY
      );
      const n1m = s1.wj - s1.wi + 1, n2m = s2.wj - s2.wi + 1;
      let collinearShift = false;
      if (!shortAbsorb) {
        const [pLong, pShort] = len1 >= len2 ? [p1, p2] : [p2, p1];
        const lenLong = Math.max(len1, len2);
        const perpX = -(pLong.y2 - pLong.y1) / lenLong, perpY = (pLong.x2 - pLong.x1) / lenLong;
        const msx = (pShort.x1 + pShort.x2) / 2, msy = (pShort.y1 + pShort.y2) / 2;
        const latOffset = Math.abs((msx - pLong.x1) * perpX + (msy - pLong.y1) * perpY);
        collinearShift = latOffset <= LATERAL_SHIFT_MAX;
      }
      if (mergedCE > QUANT_FLOOR && mergedCE > maxCE) continue;
      if (!shortAbsorb && !collinearShift && mergedCE > QUANT_FLOOR && mergedCE * (n1m + n2m) > s1.ce * n1m + s2.ce * n2m + mdlPenalty) continue;
      let mergedFrozen = false;
      if (s1.frozen || s2.frozen) {
        const fp = s1.frozen ? p1 : p2;
        const fdx = fp.x2 - fp.x1, fdy = fp.y2 - fp.y1;
        const flen = Math.hypot(fdx, fdy);
        if (flen < 1e-9) continue;
        const rotPx = Math.abs(fdx * lDirY - fdy * lDirX);
        mergedFrozen = rotPx <= FREEZE_NO_ROTATION_PX;
        if (rotPx > FREEZE_NO_ROTATION_PX) {
          const frozenCE = lineCEFast(
            vertStats,
            s1.wi,
            s2.wj,
            fp.x1,
            fp.y1,
            fdx / flen,
            fdy / flen
          );
          if (!(mergedCE < frozenCE * FREEZE_OVERRIDE_RATIO && mergedCE < frozenCE - FREEZE_OVERRIDE_MIN_PX)) continue;
        }
      }
      const tFirst = (vStart.x - lCx) * lDirX + (vStart.y - lCy) * lDirY;
      const tLast = (vEnd.x - lCx) * lDirX + (vEnd.y - lCy) * lDirY;
      const mergedPrim = makeLinePrimitive(
        lCx + tFirst * lDirX,
        lCy + tFirst * lDirY,
        lCx + tLast * lDirX,
        lCy + tLast * lDirY
      );
      recon.splice(i, 2, {
        wi: s1.wi,
        wj: s2.wj,
        prim: mergedPrim,
        ce: mergedCE,
        ...mergedFrozen ? { frozen: true } : {}
      });
      changed = true;
      break;
    }
    for (let i = 1; i < recon.length - 1; i++) {
      const sc = recon[i];
      if (sc.prim.type !== "line") continue;
      const pc = sc.prim;
      const stubLen = Math.hypot(pc.x2 - pc.x1, pc.y2 - pc.y1);
      if (stubLen >= cornerStubMax) continue;
      const sp = recon[i - 1], sn = recon[i + 1];
      if (sp.prim.type !== "line" || sn.prim.type !== "line") continue;
      const pp = sp.prim, pn = sn.prim;
      const pdx = pp.x2 - pp.x1, pdy = pp.y2 - pp.y1;
      const ndx = pn.x2 - pn.x1, ndy = pn.y2 - pn.y1;
      const pLen = Math.hypot(pdx, pdy), nLen = Math.hypot(ndx, ndy);
      if (pLen < 1e-10 || nLen < 1e-10) continue;
      if (pLen < stubLen * 3 || nLen < stubLen * 3) continue;
      const cdx = pc.x2 - pc.x1, cdy = pc.y2 - pc.y1;
      const dotPC = (cdx * pdx + cdy * pdy) / (stubLen * pLen);
      const isAntiParallel = dotPC < -0.5;
      if (!isAntiParallel && sc.ce > stubLen * 0.02) continue;
      const denom = pdx * ndy - pdy * ndx;
      if (Math.abs(denom) / (pLen * nLen) < 0.25) {
        const mx = sp.frozen && !sn.frozen ? pp.x2 : sn.frozen && !sp.frozen ? pn.x1 : (pp.x2 + pn.x1) / 2;
        const my = sp.frozen && !sn.frozen ? pp.y2 : sn.frozen && !sp.frozen ? pn.y1 : (pp.y2 + pn.y1) / 2;
        if ((mx - pp.x1) * pdx + (my - pp.y1) * pdy <= 0) continue;
        if ((pn.x2 - mx) * ndx + (pn.y2 - my) * ndy <= 0) continue;
        pp.x2 = mx;
        pp.y2 = my;
        pn.x1 = mx;
        pn.y1 = my;
        recon.splice(i, 1);
        changed = true;
        break;
      }
      if (!isAntiParallel) continue;
      const gx = pn.x1 - pp.x2, gy = pn.y1 - pp.y2;
      const t = (gx * ndy - gy * ndx) / denom;
      const s = (gx * pdy - gy * pdx) / denom;
      if (t < 0 || s > 0) continue;
      const ix = pp.x2 + t * pdx, iy = pp.y2 + t * pdy;
      if (Math.hypot(ix - pc.x1, iy - pc.y1) > stubLen * 4) continue;
      pp.x2 = ix;
      pp.y2 = iy;
      pn.x1 = ix;
      pn.y1 = iy;
      recon.splice(i, 1);
      changed = true;
      break;
    }
  }
}
function refitPoorSpans(recon, connectors, denseVerts, pixelsPerVert, vertStats, opts) {
  const REFIT_TOL_PX = 1.5;
  const MAX_SPAN_VERTS = 1500;
  const distTo = (p, x, y) => {
    if (p.type === "line") {
      const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - p.x1) * dx + (y - p.y1) * dy) / L2)) : 0;
      return Math.hypot(x - (p.x1 + t * dx), y - (p.y1 + t * dy));
    }
    if (p.type === "arc") return Math.abs(Math.hypot(x - p.cx, y - p.cy) - p.r);
    return Infinity;
  };
  const worstOver = (entries, lo, hi) => {
    let worst = 0;
    for (let vi = lo; vi <= hi; vi++) {
      const v = denseVerts[vi];
      let best = Infinity;
      for (const e of entries) {
        const d = distTo(e.prim, v.x, v.y);
        if (d < best) best = d;
      }
      if (best !== Infinity && best > worst) worst = best;
    }
    return worst;
  };
  const poor = new Set(connectors.flatMap((k) => [k - 1, k, k + 1]));
  for (let i = 0; i < recon.length; i++) {
    const e = recon[i];
    if (e.wj <= e.wi) continue;
    for (let vi = e.wi; vi <= e.wj; vi++) {
      const v = denseVerts[vi];
      if (v && distTo(e.prim, v.x, v.y) > REFIT_TOL_PX) {
        poor.add(i);
        break;
      }
    }
  }
  if (poor.size === 0) return;
  const idx = [...poor].filter((i) => i >= 0 && i < recon.length).sort((a, b) => a - b);
  const runs = [];
  for (const i of idx) {
    const last = runs[runs.length - 1];
    if (last && i <= last[1] + 1) last[1] = i;
    else runs.push([i, i]);
  }
  for (let r = runs.length - 1; r >= 0; r--) {
    const a = Math.max(0, runs[r][0] - 1);
    const b = Math.min(recon.length - 1, runs[r][1] + 1);
    const lo = recon[a].wi, hi = recon[b].wj;
    if (hi - lo < 8 || hi - lo > MAX_SPAN_VERTS) continue;
    if (lo < 0 || hi >= denseVerts.length) continue;
    const before = recon.slice(a, b + 1);
    const wasWorst = worstOver(before, lo, hi);
    if (wasWorst <= 0.5) continue;
    const sliceVerts = denseVerts.slice(lo, hi + 1);
    const slicePx = pixelsPerVert.slice(lo, hi + 1);
    const sliceStats = vertStats.slice(lo * 6, (hi + 1) * 6);
    const budget = before.length + 2;
    let bestFit = null;
    let bestWorst = wasWorst;
    for (const scale of [1, 0.5, 0.25, 0.1, 0.03]) {
      const refit = fitDenseChain(sliceVerts, slicePx, sliceStats, {
        ...opts,
        mdlPenalty: (opts.mdlPenalty ?? 3) * scale
      });
      if (refit.length === 0 || refit.length > budget) continue;
      const shifted = refit.map((e) => ({
        wi: e.wi + lo,
        wj: e.wj + lo,
        prim: e.prim,
        ce: e.ce
      }));
      const w = worstOver(shifted, lo, hi);
      if (w < bestWorst * 0.9) {
        bestWorst = w;
        bestFit = shifted;
      }
    }
    if (!bestFit) continue;
    if ((opts.freezeMinLenPx ?? 0) > 0) {
      freezeConfidentLines(bestFit, vertStats, opts.freezeMinLenPx, opts.freezeMaxCE ?? 0.25);
    }
    recon.splice(a, b - a + 1, ...bestFit);
  }
}
function absorbShortArcLines(recon, maxLen, absorbTol = 2) {
  const radialErr = (p, x, y) => Math.abs(Math.hypot(x - p.cx, y - p.cy) - p.r);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < recon.length; i++) {
      const seg = recon[i];
      if (seg.prim.type !== "line") continue;
      const line = seg.prim;
      const len = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
      if (len >= maxLen) continue;
      const prev = i > 0 ? recon[i - 1] : null;
      const next = i + 1 < recon.length ? recon[i + 1] : null;
      const prevArc = prev && prev.prim.type === "arc" ? prev.prim : null;
      const nextArc = next && next.prim.type === "arc" ? next.prim : null;
      if (!prevArc && !nextArc) continue;
      const prevErr = prevArc ? Math.max(
        radialErr(prevArc, line.x1, line.y1),
        radialErr(prevArc, line.x2, line.y2)
      ) : Infinity;
      const nextErr = nextArc ? Math.max(
        radialErr(nextArc, line.x1, line.y1),
        radialErr(nextArc, line.x2, line.y2)
      ) : Infinity;
      const candidates = nextErr < prevErr ? ["next", "prev"] : ["prev", "next"];
      let absorbed = false;
      for (const which of candidates) {
        const arc = which === "next" ? nextArc : prevArc;
        const err = which === "next" ? nextErr : prevErr;
        if (!arc || err > absorbTol) continue;
        if (which === "next") {
          if (!snapArcAngle(arc, Math.atan2(line.y1 - arc.cy, line.x1 - arc.cx), true)) continue;
          next.wi = Math.min(next.wi, seg.wi);
        } else {
          if (!snapArcAngle(arc, Math.atan2(line.y2 - arc.cy, line.x2 - arc.cx), false)) continue;
          prev.wj = Math.max(prev.wj, seg.wj);
        }
        absorbed = true;
        break;
      }
      if (!absorbed) continue;
      recon.splice(i, 1);
      changed = true;
      break;
    }
  }
}
function lineMeetsCircle(px, py, ux, uy, ccx, ccy, r, rx, ry) {
  const fx = px - ccx, fy = py - ccy;
  const b = 2 * (fx * ux + fy * uy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * c;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  const cands = [(-b - sq) / 2, (-b + sq) / 2].map((t) => ({ x: px + t * ux, y: py + t * uy }));
  return Math.hypot(cands[0].x - rx, cands[0].y - ry) <= Math.hypot(cands[1].x - rx, cands[1].y - ry) ? cands[0] : cands[1];
}
function relaxCuspsToLine(recon, pverts, dv) {
  const N = dv.length;
  if (recon.length < 2 || N < 8) return;
  const cx = new Float64Array(N), cy = new Float64Array(N);
  for (let vi = 0; vi < N; vi++) {
    const pxs = pverts[vi];
    if (pxs && pxs.length >= 2) {
      let sx = 0, sy = 0;
      for (const p of pxs) {
        sx += p.x;
        sy += p.y;
      }
      cx[vi] = sx / pxs.length;
      cy[vi] = sy / pxs.length;
    } else {
      cx[vi] = dv[vi].x;
      cy[vi] = dv[vi].y;
    }
  }
  const devAt = (p, vi) => {
    if (p.type === "arc") return Math.abs(Math.hypot(cx[vi] - p.cx, cy[vi] - p.cy) - p.r);
    const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
    const L2 = dx * dx + dy * dy;
    if (L2 < 1e-18) return Math.hypot(cx[vi] - p.x1, cy[vi] - p.y1);
    const t = Math.max(0, Math.min(1, ((cx[vi] - p.x1) * dx + (cy[vi] - p.y1) * dy) / L2));
    return Math.hypot(cx[vi] - (p.x1 + t * dx), cy[vi] - (p.y1 + t * dy));
  };
  const score = (pieces) => {
    let worst = 0, sum = 0, n = 0;
    for (const { p, a, b } of pieces) {
      for (let vi = Math.max(0, a); vi <= Math.min(N - 1, b); vi++) {
        const d = devAt(p, vi);
        worst = Math.max(worst, d);
        sum += d;
        n++;
      }
    }
    return { worst, mean: n ? sum / n : Infinity };
  };
  for (let i = 0; i + 1 < recon.length; i++) {
    const A = recon[i], B = recon[i + 1];
    const pa = A.prim, pb = B.prim;
    if (pa.type !== "arc" || pb.type !== "arc") continue;
    if (pa.ccw !== pb.ccw) continue;
    const t02 = primitiveTangentAt(pa, false);
    const t1 = primitiveTangentAt(pb, true);
    const cross = t02.tx * t1.ty - t02.ty * t1.tx;
    const dot = t02.tx * t1.tx + t02.ty * t1.ty;
    const turn = Math.atan2(cross, dot);
    if (Math.abs(turn) < 4 * Math.PI / 180) continue;
    const bend = pa.ccw ? 1 : -1;
    if (Math.sign(turn) === bend) continue;
    const k = A.wj;
    const before = score([{ p: pa, a: A.wi, b: A.wj }, { p: pb, a: B.wi, b: B.wj }]);
    const savedA = { s: pa.startAngle, e: pa.endAngle, w: pa.sweep };
    const savedB = { s: pb.startAngle, e: pb.endAngle, w: pb.sweep };
    const mMax = Math.min(8, A.wj - A.wi >> 1, B.wj - B.wi >> 1);
    let placed = false;
    for (let m = mMax; m >= 3 && !placed; m--) {
      const lo = k - m, hi = k + m;
      if (lo < 0 || hi >= N) continue;
      let sx = 0, sy = 0, n = 0;
      for (let vi = lo; vi <= hi; vi++) {
        sx += cx[vi];
        sy += cy[vi];
        n++;
      }
      const mx = sx / n, my = sy / n;
      let sxx = 0, sxy = 0, syy = 0;
      for (let vi = lo; vi <= hi; vi++) {
        const ex = cx[vi] - mx, ey = cy[vi] - my;
        sxx += ex * ex;
        sxy += ex * ey;
        syy += ey * ey;
      }
      const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
      const ux = Math.cos(theta), uy = Math.sin(theta);
      const J0 = lineMeetsCircle(mx, my, ux, uy, pa.cx, pa.cy, pa.r, cx[lo], cy[lo]);
      const J1 = lineMeetsCircle(mx, my, ux, uy, pb.cx, pb.cy, pb.r, cx[hi], cy[hi]);
      if (!J0 || !J1) continue;
      if (Math.hypot(J1.x - J0.x, J1.y - J0.y) < 1e-6) continue;
      if (!snapArcAngle(pa, Math.atan2(J0.y - pa.cy, J0.x - pa.cx), false)) continue;
      if (!snapArcAngle(pb, Math.atan2(J1.y - pb.cy, J1.x - pb.cx), true)) {
        pa.startAngle = savedA.s;
        pa.endAngle = savedA.e;
        pa.sweep = savedA.w;
        continue;
      }
      const bridge = makeLinePrimitive(J0.x, J0.y, J1.x, J1.y);
      const nearestVert = (px, py) => {
        let best = lo, bd = Infinity;
        for (let vi = Math.max(0, A.wi); vi <= Math.min(N - 1, B.wj); vi++) {
          const d = (cx[vi] - px) ** 2 + (cy[vi] - py) ** 2;
          if (d < bd) {
            bd = d;
            best = vi;
          }
        }
        return best;
      };
      const bLo = nearestVert(J0.x, J0.y);
      const bHi = nearestVert(J1.x, J1.y);
      if (bHi <= bLo) {
        pa.startAngle = savedA.s;
        pa.endAngle = savedA.e;
        pa.sweep = savedA.w;
        pb.startAngle = savedB.s;
        pb.endAngle = savedB.e;
        pb.sweep = savedB.w;
        continue;
      }
      const after = score([
        { p: pa, a: A.wi, b: bLo },
        { p: bridge, a: bLo, b: bHi },
        { p: pb, a: bHi, b: B.wj }
      ]);
      if (after.worst > Math.max(before.worst, 0.6) || after.mean > before.mean + 0.1) {
        pa.startAngle = savedA.s;
        pa.endAngle = savedA.e;
        pa.sweep = savedA.w;
        pb.startAngle = savedB.s;
        pb.endAngle = savedB.e;
        pb.sweep = savedB.w;
        continue;
      }
      A.wj = bLo;
      B.wi = bHi;
      recon.splice(i + 1, 0, { wi: bLo, wj: bHi, ce: after.mean, prim: bridge });
      placed = true;
    }
    if (placed) i++;
  }
}
function weldChainJunctions(recon, isClosed, maxGap) {
  if (recon.length < 2) return;
  const onCircle = (a, mx, my) => {
    const dx = mx - a.cx, dy = my - a.cy;
    const d = Math.hypot(dx, dy);
    if (d < 1e-9) return null;
    return { x: a.cx + a.r * dx / d, y: a.cy + a.r * dy / d };
  };
  const weldPair = (sa, sb) => {
    const pa = sa.prim, pb = sb.prim;
    const E0 = primitiveEndPoint(pa, false);
    const E1 = primitiveEndPoint(pb, true);
    const gap = Math.hypot(E1.x - E0.x, E1.y - E0.y);
    if (gap <= 1e-9 || gap > maxGap) return;
    const mx = (E0.x + E1.x) * 0.5, my = (E0.y + E1.y) * 0.5;
    if (pa.type === "line" && pb.type === "line") {
      const dx0 = pa.x2 - pa.x1, dy0 = pa.y2 - pa.y1;
      const dx1 = pb.x2 - pb.x1, dy1 = pb.y2 - pb.y1;
      const l0 = Math.hypot(dx0, dy0), l1 = Math.hypot(dx1, dy1);
      let Jx = mx, Jy = my;
      let haveIx = false;
      if (l0 > 1e-9 && l1 > 1e-9 && Math.abs(dx0 * dy1 - dy0 * dx1) >= 0.035 * l0 * l1) {
        const ix = lineLineIntersect(pa.x1, pa.y1, dx0, dy0, pb.x1, pb.y1, dx1, dy1);
        if (ix && Math.hypot(ix.x - mx, ix.y - my) <= gap * 2 + 1) {
          Jx = ix.x;
          Jy = ix.y;
          haveIx = true;
        }
      }
      if (!haveIx) {
        if (sa.frozen && !sb.frozen && l0 > 1e-9) {
          const t = ((mx - pa.x1) * dx0 + (my - pa.y1) * dy0) / (l0 * l0);
          Jx = pa.x1 + t * dx0;
          Jy = pa.y1 + t * dy0;
        } else if (sb.frozen && !sa.frozen && l1 > 1e-9) {
          const t = ((mx - pb.x1) * dx1 + (my - pb.y1) * dy1) / (l1 * l1);
          Jx = pb.x1 + t * dx1;
          Jy = pb.y1 + t * dy1;
        }
      }
      pa.x2 = Jx;
      pa.y2 = Jy;
      pb.x1 = Jx;
      pb.y1 = Jy;
      return;
    }
    const axisLocked = (s, l) => s.frozen === true || Math.abs(l.y2 - l.y1) <= 1e-6 || Math.abs(l.x2 - l.x1) <= 1e-6;
    const projectOnto = (s, l) => {
      if (!axisLocked(s, l)) return null;
      const ux = l.x2 - l.x1, uy = l.y2 - l.y1;
      const ll = Math.hypot(ux, uy);
      if (ll < 1e-9) return null;
      const t = ((mx - l.x1) * ux + (my - l.y1) * uy) / (ll * ll);
      return { x: l.x1 + t * ux, y: l.y1 + t * uy };
    };
    const meetOnCircle = (l, a, lineEndMoves) => {
      const j = lineArcJunction(
        l.x1,
        l.y1,
        l.x2,
        l.y2,
        a.cx,
        a.cy,
        a.r,
        lineEndMoves ? 1 : 0,
        2
      );
      if (!j || Math.hypot(j.x - mx, j.y - my) > gap * 2 + 1) return false;
      if (!snapArcAngle(a, Math.atan2(j.y - a.cy, j.x - a.cx), lineEndMoves)) return false;
      if (lineEndMoves) {
        l.x2 = j.x;
        l.y2 = j.y;
      } else {
        l.x1 = j.x;
        l.y1 = j.y;
      }
      return true;
    };
    if (pa.type === "line" && pb.type === "arc") {
      if (meetOnCircle(
        pa,
        pb,
        /*lineEndMoves=*/
        true
      )) return;
      const J = projectOnto(sa, pa);
      if (J && reanchorArcThrough(
        pb,
        J.x,
        J.y,
        /*atStart=*/
        true
      )) {
        pa.x2 = J.x;
        pa.y2 = J.y;
        return;
      }
      const K = onCircle(pb, mx, my);
      if (!K) return;
      if (!snapArcAngle(pb, Math.atan2(K.y - pb.cy, K.x - pb.cx), true)) return;
      pa.x2 = K.x;
      pa.y2 = K.y;
      return;
    }
    if (pa.type === "arc" && pb.type === "line") {
      if (meetOnCircle(
        pb,
        pa,
        /*lineEndMoves=*/
        false
      )) return;
      const J = projectOnto(sb, pb);
      if (J && reanchorArcThrough(
        pa,
        J.x,
        J.y,
        /*atStart=*/
        false
      )) {
        pb.x1 = J.x;
        pb.y1 = J.y;
        return;
      }
      const K = onCircle(pa, mx, my);
      if (!K) return;
      if (!snapArcAngle(pa, Math.atan2(K.y - pa.cy, K.x - pa.cx), false)) return;
      pb.x1 = K.x;
      pb.y1 = K.y;
      return;
    }
    const a0 = pa, a1 = pb;
    if (joinArcsExactly(a0, a1)) return;
    const newR = Math.hypot(E0.x - a1.cx, E0.y - a1.cy);
    if (newR < 1) return;
    const prevR = a1.r;
    a1.r = newR;
    if (!snapArcAngle(a1, Math.atan2(E0.y - a1.cy, E0.x - a1.cx), true)) a1.r = prevR;
  };
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i + 1 < recon.length; i++) weldPair(recon[i], recon[i + 1]);
    if (isClosed) weldPair(recon[recon.length - 1], recon[0]);
  }
}
function extendEndsToOtherInk(keptByChain, chainInfos, maxExtend) {
  const chords = [];
  for (let ci = 0; ci < keptByChain.length; ci++) {
    const kept = keptByChain[ci];
    if (!kept) continue;
    const layer = chainInfos[ci]?.layer ?? 0;
    for (const s of kept) {
      const p = s.prim;
      if (p.type === "line") {
        chords.push({ x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2, layer });
      } else {
        const n = Math.max(2, Math.ceil(p.r * p.sweep / 4));
        const d = (p.ccw ? p.sweep : -p.sweep) / n;
        let px = p.cx + p.r * Math.cos(p.startAngle);
        let py = p.cy + p.r * Math.sin(p.startAngle);
        for (let i = 1; i <= n; i++) {
          const t = p.startAngle + d * i;
          const qx = p.cx + p.r * Math.cos(t), qy = p.cy + p.r * Math.sin(t);
          chords.push({ x1: px, y1: py, x2: qx, y2: qy, layer });
          px = qx;
          py = qy;
        }
      }
    }
  }
  const MIN_SIN = 0.34;
  const endCount = /* @__PURE__ */ new Map();
  for (let ci = 0; ci < keptByChain.length; ci++) {
    const kept = keptByChain[ci];
    const info = chainInfos[ci];
    if (!kept || kept.length === 0 || !info || info.isClosed) continue;
    for (const atStart of [true, false]) {
      const q = primitiveEndPoint((atStart ? kept[0] : kept[kept.length - 1]).prim, atStart);
      const k = `${q.x.toFixed(4)},${q.y.toFixed(4)}`;
      endCount.set(k, (endCount.get(k) ?? 0) + 1);
    }
  }
  for (let ci = 0; ci < keptByChain.length; ci++) {
    const kept = keptByChain[ci];
    const info = chainInfos[ci];
    if (!kept || kept.length === 0 || !info || info.isClosed) continue;
    for (const atStart of [true, false]) {
      const seg = atStart ? kept[0] : kept[kept.length - 1];
      const P = primitiveEndPoint(seg.prim, atStart);
      const T = primitiveTangentAt(seg.prim, atStart);
      const ux = atStart ? -T.tx : T.tx;
      const uy = atStart ? -T.ty : T.ty;
      if ((endCount.get(`${P.x.toFixed(4)},${P.y.toFixed(4)}`) ?? 0) > 1) continue;
      let bestT = Infinity, bx = 0, by = 0;
      for (const c of chords) {
        if (c.layer === info.layer) continue;
        const rx = c.x2 - c.x1, ry = c.y2 - c.y1;
        const den = ux * ry - uy * rx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((c.x1 - P.x) * ry - (c.y1 - P.y) * rx) / den;
        if (!(t > 1e-6) || t > maxExtend || t >= bestT) continue;
        const s2 = ((c.x1 - P.x) * uy - (c.y1 - P.y) * ux) / den;
        if (s2 < 0 || s2 > 1) continue;
        const rl = Math.hypot(rx, ry);
        if (rl < 1e-9 || Math.abs(den) / rl < MIN_SIN) continue;
        bestT = t;
        bx = P.x + t * ux;
        by = P.y + t * uy;
      }
      if (!Number.isFinite(bestT)) continue;
      const p = seg.prim;
      if (p.type === "line") {
        if (atStart) {
          p.x1 = bx;
          p.y1 = by;
        } else {
          p.x2 = bx;
          p.y2 = by;
        }
      } else {
        continue;
      }
    }
  }
}
function dropIsolatedSpecks(keptByChain, minLengthPx) {
  const TOUCH = 0.5;
  let dropped = 0;
  for (let ci = 0; ci < keptByChain.length; ci++) {
    const kept = keptByChain[ci];
    if (!kept || kept.length !== 1) continue;
    const p = kept[0].prim;
    if (p.type !== "line") continue;
    if (Math.hypot(p.x2 - p.x1, p.y2 - p.y1) >= minLengthPx) continue;
    let attached = false;
    for (const atStart of [true, false]) {
      const e = primitiveEndPoint(p, atStart);
      for (let cj = 0; cj < keptByChain.length && !attached; cj++) {
        if (cj === ci) continue;
        const other = keptByChain[cj];
        if (!other) continue;
        for (const o of other) {
          for (const os of [true, false]) {
            const q = primitiveEndPoint(o.prim, os);
            if (Math.hypot(q.x - e.x, q.y - e.y) <= TOUCH) {
              attached = true;
              break;
            }
          }
          if (attached) break;
        }
      }
    }
    if (attached) continue;
    keptByChain[ci] = [];
    dropped++;
  }
  return dropped;
}
function consolidateCircles(keptByChain, chainInfos) {
  const out = [];
  const CENTRE_TOL = 2;
  const RADIUS_TOL = 2;
  const MIN_COVER = 0.6;
  const MAX_GAP_ANGLE = 45 * Math.PI / 180;
  const TOUCH = 0.5;
  const pieces = [];
  for (let ci = 0; ci < keptByChain.length; ci++) {
    const kept = keptByChain[ci];
    if (!kept) continue;
    for (let si = 0; si < kept.length; si++) {
      if (kept[si].prim.type === "arc") pieces.push({ ci, si, arc: kept[si].prim });
    }
  }
  if (pieces.length < 2) return out;
  const chordsOn = (cx, cy, r, layer) => {
    const found = [];
    for (let ci = 0; ci < keptByChain.length; ci++) {
      const kept = keptByChain[ci];
      if (!kept || chainInfos[ci].layer !== layer) continue;
      for (let si = 0; si < kept.length; si++) {
        const p = kept[si].prim;
        if (p.type !== "line") continue;
        const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
        if (len > r) continue;
        const d1 = Math.hypot(p.x1 - cx, p.y1 - cy);
        const d2 = Math.hypot(p.x2 - cx, p.y2 - cy);
        if (Math.abs(d1 - r) > RADIUS_TOL || Math.abs(d2 - r) > RADIUS_TOL) continue;
        const t1 = Math.atan2(p.y1 - cy, p.x1 - cx), t2 = Math.atan2(p.y2 - cy, p.x2 - cx);
        found.push({ ci, si, a0: t1, a1: t2 });
      }
    }
    return found;
  };
  const used = /* @__PURE__ */ new Set();
  const removed = /* @__PURE__ */ new Set();
  for (let i = 0; i < pieces.length; i++) {
    if (used.has(i)) continue;
    const seed = pieces[i].arc;
    const layer = chainInfos[pieces[i].ci].layer;
    const group = [i];
    for (let j = i + 1; j < pieces.length; j++) {
      if (used.has(j)) continue;
      if (chainInfos[pieces[j].ci].layer !== layer) continue;
      const a = pieces[j].arc;
      if (Math.hypot(a.cx - seed.cx, a.cy - seed.cy) > CENTRE_TOL) continue;
      if (Math.abs(a.r - seed.r) > RADIUS_TOL) continue;
      group.push(j);
    }
    if (group.length < 2) continue;
    const spans = [];
    for (const gi of group) {
      const a = pieces[gi].arc;
      const start = a.ccw ? a.startAngle : a.startAngle - a.sweep;
      let lo = (start % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      spans.push([lo, lo + Math.min(a.sweep, 2 * Math.PI)]);
    }
    const chords = chordsOn(seed.cx, seed.cy, seed.r, layer);
    for (const c of chords) {
      let lo = (Math.min(c.a0, c.a1) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      let d = Math.abs(c.a1 - c.a0);
      if (d > Math.PI) d = 2 * Math.PI - d;
      spans.push([lo, lo + d]);
    }
    spans.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const [lo, hi] of spans) {
      const last = merged[merged.length - 1];
      if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
      else merged.push([lo, Math.min(hi, lo + 2 * Math.PI)]);
    }
    for (const m of merged) {
      if (m[1] > 2 * Math.PI) {
        const wrap = [0, m[1] - 2 * Math.PI];
        m[1] = 2 * Math.PI;
        merged.push(wrap);
      }
    }
    merged.sort((p, q) => p[0] - q[0]);
    const flat = [];
    for (const [lo, hi] of merged) {
      const last = flat[flat.length - 1];
      if (last && lo <= last[1]) last[1] = Math.max(last[1], hi);
      else flat.push([lo, hi]);
    }
    let covered = 0;
    for (const [lo, hi] of flat) covered += hi - lo;
    let maxGap = 0;
    for (let k = 0; k < flat.length; k++) {
      const next = flat[(k + 1) % flat.length];
      const gap = k + 1 < flat.length ? next[0] - flat[k][1] : flat[0][0] + 2 * Math.PI - flat[k][1];
      if (gap > maxGap) maxGap = gap;
    }
    if (maxGap > MAX_GAP_ANGLE) continue;
    if (covered < MIN_COVER * 2 * Math.PI) continue;
    const inGroup = /* @__PURE__ */ new Set([
      ...group.map((gi) => `${pieces[gi].ci}:${pieces[gi].si}`),
      ...chords.map((c) => `${c.ci}:${c.si}`)
    ]);
    let attached = false;
    for (const gi of group) {
      for (const atStart of [true, false]) {
        const e = primitiveEndPoint(pieces[gi].arc, atStart);
        for (let ci = 0; ci < keptByChain.length && !attached; ci++) {
          const kept = keptByChain[ci];
          if (!kept) continue;
          for (let si = 0; si < kept.length; si++) {
            if (inGroup.has(`${ci}:${si}`) || removed.has(`${ci}:${si}`)) continue;
            for (const os of [true, false]) {
              const o = primitiveEndPoint(kept[si].prim, os);
              if (Math.hypot(o.x - e.x, o.y - e.y) <= TOUCH) {
                attached = true;
                break;
              }
            }
            if (attached) break;
          }
        }
      }
    }
    if (attached) continue;
    let wsum = 0, cx = 0, cy = 0, r = 0;
    for (const gi of group) {
      const a = pieces[gi].arc, w = a.sweep;
      wsum += w;
      cx += a.cx * w;
      cy += a.cy * w;
      r += a.r * w;
    }
    cx /= wsum;
    cy /= wsum;
    r /= wsum;
    out.push({
      layer,
      chainId: pieces[group[0]].ci,
      primitive: { type: "circle", cx, cy, r }
    });
    for (const gi of group) {
      const p = pieces[gi];
      removed.add(`${p.ci}:${p.si}`);
      used.add(gi);
    }
    for (const c of chords) removed.add(`${c.ci}:${c.si}`);
  }
  if (removed.size > 0) {
    for (let ci = 0; ci < keptByChain.length; ci++) {
      const kept = keptByChain[ci];
      if (!kept) continue;
      keptByChain[ci] = kept.filter((_, si) => !removed.has(`${ci}:${si}`));
    }
  }
  return out;
}
function weldCrossChainJunctions(keptByChain, chainInfos, maxGap) {
  const ends = [];
  for (let ci = 0; ci < keptByChain.length; ci++) {
    const kept = keptByChain[ci];
    if (!kept || kept.length === 0) continue;
    const info = chainInfos[ci];
    if (!info || info.isClosed) continue;
    ends.push({ ci, atStart: true, prim: kept[0].prim, layer: info.layer, vi: info.startVi });
    ends.push({ ci, atStart: false, prim: kept[kept.length - 1].prim, layer: info.layer, vi: info.endVi });
  }
  const NEAR_COINCIDENT = 0.75;
  const CONVERGE_DOT = 0.5;
  const outwardDir = (e) => {
    const t = primitiveTangentAt(e.prim, e.atStart);
    return e.atStart ? { x: -t.tx, y: -t.ty } : { x: t.tx, y: t.ty };
  };
  const converges = (a, b) => {
    const qa = primitiveEndPoint(a.prim, a.atStart);
    const qb = primitiveEndPoint(b.prim, b.atStart);
    const gx = qb.x - qa.x, gy = qb.y - qa.y;
    const g = Math.hypot(gx, gy);
    if (g < 1e-9) return true;
    const da = outwardDir(a), db2 = outwardDir(b);
    const towardB = (da.x * gx + da.y * gy) / g;
    const towardA = (db2.x * -gx + db2.y * -gy) / g;
    return Math.max(towardB, towardA) >= CONVERGE_DOT;
  };
  const used = new Uint8Array(ends.length);
  for (let i = 0; i < ends.length; i++) {
    if (used[i]) continue;
    const group = [i];
    used[i] = 1;
    let grew = true;
    while (grew) {
      grew = false;
      for (let j = 0; j < ends.length; j++) {
        if (used[j] || ends[j].layer !== ends[i].layer) continue;
        const qj = primitiveEndPoint(ends[j].prim, ends[j].atStart);
        for (const k of group) {
          const qk = primitiveEndPoint(ends[k].prim, ends[k].atStart);
          const d = Math.hypot(qk.x - qj.x, qk.y - qj.y);
          if (d > maxGap) continue;
          const sameVertex = ends[j].vi === ends[k].vi;
          if (!sameVertex && d > NEAR_COINCIDENT && !converges(ends[k], ends[j])) continue;
          group.push(j);
          used[j] = 1;
          grew = true;
          break;
        }
      }
    }
    if (group.length < 2) continue;
    let sx = 0, sy = 0, spread = 0;
    for (const a of group) {
      const qa = primitiveEndPoint(ends[a].prim, ends[a].atStart);
      sx += qa.x;
      sy += qa.y;
      for (const b of group) {
        const qb = primitiveEndPoint(ends[b].prim, ends[b].atStart);
        spread = Math.max(spread, Math.hypot(qa.x - qb.x, qa.y - qb.y));
      }
    }
    if (spread <= 1e-9 || spread > maxGap) continue;
    const jx = sx / group.length, jy = sy / group.length;
    for (const k of group) {
      const e = ends[k];
      if (e.prim.type === "line") {
        if (e.atStart) {
          e.prim.x1 = jx;
          e.prim.y1 = jy;
        } else {
          e.prim.x2 = jx;
          e.prim.y2 = jy;
        }
      } else {
        reanchorArcThrough(e.prim, jx, jy, e.atStart);
      }
    }
  }
}
function stitchJunctions(recon) {
  const SIN_THRESH = 0.34;
  for (let i = 0; i + 1 < recon.length; i++) {
    const p0 = recon[i].prim;
    const p1 = recon[i + 1].prim;
    if (p0.type !== "line" || p1.type !== "line") continue;
    if (p0.x2 === p1.x1 && p0.y2 === p1.y1) continue;
    const dx0 = p0.x2 - p0.x1, dy0 = p0.y2 - p0.y1;
    const dx1 = p1.x2 - p1.x1, dy1 = p1.y2 - p1.y1;
    const len0 = Math.hypot(dx0, dy0), len1 = Math.hypot(dx1, dy1);
    if (len0 < 1e-9 || len1 < 1e-9) continue;
    const sinAngle = Math.abs(dx0 * dy1 - dy0 * dx1) / (len0 * len1);
    if (sinAngle > SIN_THRESH) continue;
    const f0 = recon[i].frozen === true, f1 = recon[i + 1].frozen === true;
    let mx, my;
    if (f0 && !f1) {
      mx = p0.x2;
      my = p0.y2;
    } else if (f1 && !f0) {
      mx = p1.x1;
      my = p1.y1;
    } else {
      mx = (p0.x2 + p1.x1) / 2;
      my = (p0.y2 + p1.y1) / 2;
    }
    p0.x2 = mx;
    p0.y2 = my;
    p1.x1 = mx;
    p1.y1 = my;
  }
}
function snapAxisAligned(recon, maxDevPx) {
  for (const s of recon) {
    const p = s.prim;
    if (p.type !== "line") continue;
    if (Math.abs(p.y2 - p.y1) <= 2 * maxDevPx) {
      const avgY = (p.y1 + p.y2) / 2;
      p.y1 = avgY;
      p.y2 = avgY;
    } else if (Math.abs(p.x2 - p.x1) <= 2 * maxDevPx) {
      const avgX = (p.x1 + p.x2) / 2;
      p.x1 = avgX;
      p.x2 = avgX;
    }
  }
}
function postFitUndash(graph, cache, chainInfos, reconByChain, opts, maxGap, maxAngleDeg, absorbedChains) {
  const cosThresh = Math.cos(maxAngleDeg * Math.PI / 180);
  const denseSeg = opts.denseSeg ?? 2;
  const { vertices } = graph;
  function collectEPs() {
    const eps = [];
    for (let ci = 0; ci < reconByChain.length; ci++) {
      const recon = reconByChain[ci];
      if (!recon || recon.length === 0) continue;
      const info = chainInfos[ci];
      if (info.isClosed) continue;
      const svType = vertices[info.startVi]?.type;
      const evType = vertices[info.endVi]?.type;
      const chainLen = cache.chains[ci].denseVerts.length * denseSeg;
      const fp = recon[0].prim;
      if (fp.type === "line") {
        const dx = fp.x1 - fp.x2, dy = fp.y1 - fp.y2, len = Math.hypot(dx, dy);
        if (len > 1e-10)
          eps.push({
            ci,
            isStart: true,
            x: fp.x1,
            y: fp.y1,
            dx: dx / len,
            dy: dy / len,
            layer: info.layer,
            isJunction: svType === "junction",
            chainLen
          });
      }
      const lp = recon[recon.length - 1].prim;
      if (lp.type === "line") {
        const dx = lp.x2 - lp.x1, dy = lp.y2 - lp.y1, len = Math.hypot(dx, dy);
        if (len > 1e-10)
          eps.push({
            ci,
            isStart: false,
            x: lp.x2,
            y: lp.y2,
            dx: dx / len,
            dy: dy / len,
            layer: info.layer,
            isJunction: evType === "junction",
            chainLen
          });
      }
    }
    return eps;
  }
  for (let pass = 0; pass < 20; pass++) {
    const eps = collectEPs();
    const candidates = [];
    for (let a = 0; a < eps.length; a++) {
      for (let b = a + 1; b < eps.length; b++) {
        const ea = eps[a], eb = eps[b];
        if (ea.layer !== eb.layer || ea.ci === eb.ci) continue;
        if (ea.isJunction && ea.chainLen >= maxGap && eb.isJunction && eb.chainLen >= maxGap) continue;
        const gapDist = Math.hypot(eb.x - ea.x, eb.y - ea.y);
        if (gapDist > maxGap || gapDist < 0.01) continue;
        const gx = (eb.x - ea.x) / gapDist, gy = (eb.y - ea.y) / gapDist;
        const dotAB = ea.dx * gx + ea.dy * gy;
        const dotBA = eb.dx * -gx + eb.dy * -gy;
        const dotAP = ea.dx * -eb.dx + ea.dy * -eb.dy;
        if (dotAB < cosThresh || dotBA < cosThresh || dotAP < cosThresh) {
          console.debug(
            `[undash near-miss] ci${ea.ci}(${ea.isStart ? "start" : "end"})\u2194ci${eb.ci}(${eb.isStart ? "start" : "end"}) gap=${gapDist.toFixed(1)}px dotAB=${dotAB.toFixed(2)}(need\u2265${cosThresh.toFixed(2)}) dotBA=${dotBA.toFixed(2)} dotAP=${dotAP.toFixed(2)} ea@(${ea.x.toFixed(1)},${ea.y.toFixed(1)}) eb@(${eb.x.toFixed(1)},${eb.y.toFixed(1)})`
          );
          continue;
        }
        candidates.push({ ai: a, bi: b, gapDist });
      }
    }
    if (candidates.length === 0) break;
    candidates.sort((x, y) => x.gapDist - y.gapDist);
    const matchedEPs = /* @__PURE__ */ new Set();
    const matchedChains = /* @__PURE__ */ new Set();
    let anyMerge = false;
    for (const { ai, bi } of candidates) {
      if (matchedEPs.has(ai) || matchedEPs.has(bi)) continue;
      const ea = eps[ai], eb = eps[bi];
      const ciA = ea.ci, ciB = eb.ci;
      if (matchedChains.has(ciA) || matchedChains.has(ciB)) continue;
      const infoA = chainInfos[ciA], infoB = chainInfos[ciB];
      const cacheA = cache.chains[ciA], cacheB = cache.chains[ciB];
      const aAtEnd = !ea.isStart;
      const bAtStart = eb.isStart;
      let dvA = cacheA.denseVerts, pvA = cacheA.pixelsPerVert, vsA = cacheA.vertStats;
      if (!aAtEnd) {
        dvA = [...dvA].reverse();
        pvA = [...pvA].reverse();
        const nA2 = dvA.length, tmp = new Float64Array(nA2 * 6);
        for (let i = 0; i < nA2; i++) {
          const s = nA2 - 1 - i;
          tmp.set(vsA.subarray(s * 6, s * 6 + 6), i * 6);
        }
        vsA = tmp;
      }
      let dvB = cacheB.denseVerts, pvB = cacheB.pixelsPerVert, vsB = cacheB.vertStats;
      if (!bAtStart) {
        dvB = [...dvB].reverse();
        pvB = [...pvB].reverse();
        const nB2 = dvB.length, tmp = new Float64Array(nB2 * 6);
        for (let i = 0; i < nB2; i++) {
          const s = nB2 - 1 - i;
          tmp.set(vsB.subarray(s * 6, s * 6 + 6), i * 6);
        }
        vsB = tmp;
      }
      const gdist = Math.hypot(dvB[0].x - dvA[dvA.length - 1].x, dvB[0].y - dvA[dvA.length - 1].y);
      const gapN = Math.max(1, Math.round(gdist / denseSeg));
      const ax0 = dvA[dvA.length - 1].x, ay0 = dvA[dvA.length - 1].y;
      const bx0 = dvB[0].x, by0 = dvB[0].y;
      const gapDV = [];
      for (let k = 1; k <= gapN; k++) {
        const t = k / (gapN + 1);
        gapDV.push({ x: ax0 + t * (bx0 - ax0), y: ay0 + t * (by0 - ay0) });
      }
      const gapPV = gapDV.map(() => []);
      const gapVS = new Float64Array(gapN * 6);
      const nA = dvA.length, nGap = gapDV.length, nB = dvB.length;
      const mergedDV = [...dvA, ...gapDV, ...dvB];
      const mergedPV = [...pvA, ...gapPV, ...pvB];
      const mergedVS = new Float64Array((nA + nGap + nB) * 6);
      mergedVS.set(vsA, 0);
      mergedVS.set(gapVS, nA * 6);
      mergedVS.set(vsB, (nA + nGap) * 6);
      const allWin = new Float64Array(6);
      for (let vi = 0; vi < mergedDV.length; vi++) windowAdd(allWin, mergedVS, vi);
      let lDirX = 1, lDirY = 0, lCx = 0, lCy = 0;
      if (allWin[0] >= 2) {
        const r = dirFromWindow(allWin);
        lDirX = r.dirX;
        lDirY = r.dirY;
        lCx = r.cx;
        lCy = r.cy;
      } else {
        for (const v of mergedDV) {
          lCx += v.x;
          lCy += v.y;
        }
        lCx /= mergedDV.length;
        lCy /= mergedDV.length;
        const ddx = mergedDV[mergedDV.length - 1].x - mergedDV[0].x;
        const ddy = mergedDV[mergedDV.length - 1].y - mergedDV[0].y;
        const dlen = Math.hypot(ddx, ddy);
        if (dlen > 1e-10) {
          lDirX = ddx / dlen;
          lDirY = ddy / dlen;
        }
      }
      const tFirst = (mergedDV[0].x - lCx) * lDirX + (mergedDV[0].y - lCy) * lDirY;
      const tLast = (mergedDV[mergedDV.length - 1].x - lCx) * lDirX + (mergedDV[mergedDV.length - 1].y - lCy) * lDirY;
      const mergedPrim = makeLinePrimitive(
        lCx + tFirst * lDirX,
        lCy + tFirst * lDirY,
        lCx + tLast * lDirX,
        lCy + tLast * lDirY
      );
      const perpX = -lDirY, perpY = lDirX;
      {
        let worstPerp = 0;
        for (const dv of mergedDV) {
          const perp = Math.abs((dv.x - lCx) * perpX + (dv.y - lCy) * perpY);
          if (perp > worstPerp) worstPerp = perp;
        }
        if (worstPerp > denseSeg * 4) {
          continue;
        }
      }
      let newRecon = fitDenseChain(mergedDV, mergedPV, mergedVS, opts);
      if (newRecon.length === 0) {
        newRecon = [{ wi: 0, wj: mergedDV.length - 1, prim: mergedPrim, ce: 0 }];
      }
      mergeCollinearSegments(newRecon, mergedDV, mergedVS, denseSeg);
      snapAxisAligned(newRecon, opts.axisSnapPx ?? 1);
      if ((opts.freezeMinLenPx ?? 0) > 0) {
        freezeConfidentLines(
          newRecon,
          mergedVS,
          opts.freezeMinLenPx,
          opts.freezeMaxCE ?? 0.25
        );
      }
      stitchJunctions(newRecon);
      mergeCollinearSegments(newRecon, mergedDV, mergedVS, denseSeg);
      snapAxisAligned(newRecon, opts.axisSnapPx ?? 1);
      stitchJunctions(newRecon);
      const connM = snapAdjacentJunctions(newRecon);
      refitPoorSpans(newRecon, connM, mergedDV, mergedPV, mergedVS, opts);
      snapAxisAligned(newRecon, opts.axisSnapPx ?? 1);
      stitchJunctions(newRecon);
      stitchJunctions(newRecon);
      mergeCollinearSegments(newRecon, mergedDV, mergedVS, denseSeg);
      reconByChain[ciA] = newRecon;
      reconByChain[ciB] = null;
      absorbedChains.add(ciB);
      cache.chains[ciA] = { ...cacheA, denseVerts: mergedDV, pixelsPerVert: mergedPV, vertStats: mergedVS };
      infoA.startVi = aAtEnd ? infoA.startVi : infoA.endVi;
      infoA.endVi = bAtStart ? infoB.endVi : infoB.startVi;
      infoA.isClosed = false;
      matchedEPs.add(ai);
      matchedEPs.add(bi);
      matchedChains.add(ciA);
      matchedChains.add(ciB);
      anyMerge = true;
    }
    if (!anyMerge) break;
  }
}
function computeFitValidation(cache, reconByChain, absorbedChains, denseSeg, coverThreshold) {
  let droppedChains = 0;
  let totalChains = 0;
  let backwardSegments = 0;
  let disconnectedJunctions = 0;
  let sumError = 0;
  let maxError = 0;
  let coveredVertices = 0;
  const warnings = [];
  const junctionGapThresh = denseSeg * 2;
  for (let ci = 0; ci < reconByChain.length; ci++) {
    const ch = cache.chains[ci];
    const N = ch.denseVerts.length;
    if (N < 2) continue;
    totalChains++;
    const recon = reconByChain[ci];
    if (!recon || recon.length === 0) {
      if (!absorbedChains.has(ci)) {
        droppedChains++;
        const v = ch.denseVerts[0];
        warnings.push({
          ci,
          layer: ch.layer,
          type: "dropped",
          message: `Chain ${ci} (layer ${ch.layer}, ${N} verts) produced no output and was not absorbed`,
          x: v.x,
          y: v.y
        });
      }
      continue;
    }
    let si = 0;
    let chainMaxErr = 0;
    let worstV = null;
    for (let vi = 0; vi < N; vi++) {
      while (si + 1 < recon.length && recon[si].wj < vi) si++;
      const seg = recon[si];
      if (vi < seg.wi || vi > seg.wj) continue;
      const p = seg.prim;
      const vx = ch.denseVerts[vi].x, vy = ch.denseVerts[vi].y;
      let dist3;
      if (p.type === "arc") {
        dist3 = Math.abs(Math.hypot(vx - p.cx, vy - p.cy) - p.r);
      } else {
        const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
        const len = Math.hypot(dx, dy);
        if (len < 1e-10) continue;
        dist3 = Math.abs((vx - p.x1) * (-dy / len) + (vy - p.y1) * (dx / len));
      }
      coveredVertices++;
      sumError += dist3;
      if (dist3 > maxError) maxError = dist3;
      if (dist3 > chainMaxErr) {
        chainMaxErr = dist3;
        worstV = { x: vx, y: vy };
      }
    }
    if (chainMaxErr > coverThreshold && worstV) {
      warnings.push({
        ci,
        layer: ch.layer,
        type: "coverage",
        message: `Chain ${ci} (layer ${ch.layer}): max coverage error ${chainMaxErr.toFixed(2)} px > ${coverThreshold} px`,
        x: worstV.x,
        y: worstV.y
      });
    }
    for (let k = 0; k + 1 < recon.length; k++) {
      const s0 = recon[k], s1 = recon[k + 1];
      const a0 = primitiveEndPoint(s0.prim, true), b0 = primitiveEndPoint(s0.prim, false);
      const a1 = primitiveEndPoint(s1.prim, true), b1 = primitiveEndPoint(s1.prim, false);
      const dx0 = b0.x - a0.x, dy0 = b0.y - a0.y;
      const dx1 = b1.x - a1.x, dy1 = b1.y - a1.y;
      const len0 = Math.hypot(dx0, dy0), len1 = Math.hypot(dx1, dy1);
      if (len0 < 1e-6 || len1 < 1e-6) continue;
      const dot = dx0 / len0 * (dx1 / len1) + dy0 / len0 * (dy1 / len1);
      if (dot < -0.1) {
        backwardSegments++;
        const dvStart = ch.denseVerts[s1.wi], dvEnd = ch.denseVerts[Math.min(s1.wj, ch.denseVerts.length - 1)];
        const dvDx = dvEnd.x - dvStart.x, dvDy = dvEnd.y - dvStart.y;
        const dvLen = Math.hypot(dvDx, dvDy);
        const dvDot = dvLen > 1e-6 ? dx0 / len0 * (dvDx / dvLen) + dy0 / len0 * (dvDy / dvLen) : 0;
        const dvBackward = dvDot < -0.1;
        warnings.push({
          ci,
          layer: ch.layer,
          type: "backward",
          message: `Chain ${ci} (layer ${ch.layer}): segment [${s1.wi},${s1.wj}] reverses vs prev | seg:(${a1.x.toFixed(1)},${a1.y.toFixed(1)})\u2192(${b1.x.toFixed(1)},${b1.y.toFixed(1)}) | dv[${s1.wi}]=(${dvStart.x.toFixed(1)},${dvStart.y.toFixed(1)})\u2192dv[${s1.wj}]=(${dvEnd.x.toFixed(1)},${dvEnd.y.toFixed(1)}) | dv_dir_vs_prev_dot=${dvDot.toFixed(2)} (dv_backward=${dvBackward})`,
          x: a1.x,
          y: a1.y
        });
      }
    }
    for (let k = 0; k + 1 < recon.length; k++) {
      const e1 = primitiveEndPoint(recon[k].prim, false);
      const s2 = primitiveEndPoint(recon[k + 1].prim, true);
      const gap = Math.hypot(s2.x - e1.x, s2.y - e1.y);
      if (gap > junctionGapThresh) {
        disconnectedJunctions++;
        warnings.push({
          ci,
          layer: ch.layer,
          type: "junction-gap",
          message: `Chain ${ci} (layer ${ch.layer}): junction gap ${gap.toFixed(2)} px between segs ${k} and ${k + 1}`,
          x: e1.x,
          y: e1.y
        });
      }
    }
  }
  return {
    droppedChains,
    absorbedChains: absorbedChains.size,
    totalChains,
    maxCoverageError: maxError,
    meanCoverageError: coveredVertices > 0 ? sumError / coveredVertices : 0,
    coveredVertices,
    backwardSegments,
    disconnectedJunctions,
    warnings
  };
}
async function fitCurves(device, graph, decomp, opts, onProgress, outValidation) {
  const { width, height, layerCount } = graph;
  const denseSeg = opts.denseSeg ?? 2;
  const freezeMinLenPx = opts.freezeMinLenPx ?? 0;
  const freezeMaxCE = opts.freezeMaxCE ?? 0.25;
  const cache = await buildFitCache(
    device,
    graph,
    decomp,
    opts.bandWidth,
    denseSeg,
    onProgress ? (f, lbl) => onProgress(f * 0.5, lbl) : void 0
  );
  const rawChains = extractChains(graph);
  const segments = [];
  const reconByChain = [];
  const chainInfos = [];
  const total = cache.chains.length;
  let lastYield = performance.now();
  for (let ci = 0; ci < total; ci++) {
    const now2 = performance.now();
    if (now2 - lastYield > 16) {
      const pct = Math.round(ci / total * 100);
      onProgress?.(0.5 + ci / total * 0.5, `Fitting chains\u2026 ${pct}%`);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
    const ch = cache.chains[ci];
    const { layer, isClosed } = ch;
    const raw = rawChains[ci];
    const startVi = raw.vertices[0];
    const endVi = raw.vertices[raw.vertices.length - 1];
    const N = ch.denseVerts.length;
    if (N < 2) {
      reconByChain.push(null);
      chainInfos.push({ startVi, endVi, layer, isClosed });
      continue;
    }
    if (isClosed) {
      const cxArr = new Float64Array(N), cyArr = new Float64Array(N);
      for (let vi = 0; vi < N; vi++) {
        const pxs = ch.pixelsPerVert[vi];
        if (pxs.length >= 2) {
          let sx = 0, sy = 0;
          for (const p of pxs) {
            sx += p.x;
            sy += p.y;
          }
          cxArr[vi] = sx / pxs.length;
          cyArr[vi] = sy / pxs.length;
        } else {
          cxArr[vi] = ch.denseVerts[vi].x;
          cyArr[vi] = ch.denseVerts[vi].y;
        }
      }
      const cf = fitCircle(cxArr, cyArr);
      if (cf.valid && cf.r > 0) {
        let rms = 0;
        for (let vi = 0; vi < N; vi++) {
          const d = Math.hypot(cxArr[vi] - cf.cx, cyArr[vi] - cf.cy) - cf.r;
          rms += d * d;
        }
        rms = Math.sqrt(rms / N);
        if (rms <= opts.maxCenteringError) {
          segments.push({
            layer,
            chainId: ci,
            isClosed: true,
            primitive: { type: "circle", cx: cf.cx, cy: cf.cy, r: cf.r }
          });
          reconByChain.push(null);
          chainInfos.push({ startVi, endVi, layer, isClosed: true });
          continue;
        }
      }
    }
    const recon = fitDenseChain(ch.denseVerts, ch.pixelsPerVert, ch.vertStats, opts);
    if (recon.length === 0) {
      recon.push({ wi: 0, wj: N - 1, prim: makeLinePrimitive(
        ch.denseVerts[0].x,
        ch.denseVerts[0].y,
        ch.denseVerts[N - 1].x,
        ch.denseVerts[N - 1].y
      ), ce: 0 });
    }
    let conn = [];
    const passes = [
      ["merge 1", () => mergeCollinearSegments(recon, ch.denseVerts, ch.vertStats, opts.denseSeg ?? 2, opts.mdlPenalty, opts.maxCenteringError)],
      ["axis 1", () => snapAxisAligned(recon, opts.axisSnapPx ?? 1)],
      // Commit to the fits we are certain about before anything starts closing
      // junctions, so that every pass below knows which side of a joint to
      // move.  It runs after `axis 1` rather than before because that snap is
      // the last thing that can make a confident line *more* certain — a
      // horizontal that ends up exactly level is frozen exactly level.
      ["freeze", () => {
        if (freezeMinLenPx > 0) {
          freezeConfidentLines(recon, ch.vertStats, freezeMinLenPx, freezeMaxCE);
        }
      }],
      ["stitch 1", () => stitchJunctions(recon)],
      // Second merge pass: snap may have made previously-tilted segments exactly
      // H/V, revealing collinear adjacent pairs that the first pass couldn't see.
      ["merge 2", () => mergeCollinearSegments(recon, ch.denseVerts, ch.vertStats, opts.denseSeg ?? 2, opts.mdlPenalty, opts.maxCenteringError)],
      // Re-snap: the second merge uses PCA on original pixel data, which can
      // re-introduce a slight slope in segments that snap had already straightened.
      ["axis 2", () => snapAxisAligned(recon, opts.axisSnapPx ?? 1)],
      ["stitch 2", () => stitchJunctions(recon)],
      // Absorb short lines that are really chords of an adjacent arc.  A compound
      // curve whose radius changes gradually leaves a short transition span that
      // is too short to qualify as its own arc, so DP covers it with a chord line
      // that pokes out of the stroke and produces the inward-pointing inflection
      // the fitter used to emit.  Merging it into the neighbouring arc lets the
      // flanking arcs meet directly, so snapAdjacentJunctions snaps a smooth joint.
      ["absorbShortArcLines", () => absorbShortArcLines(recon, (opts.denseSeg ?? 2) * 10)],
      // Whatever the absorb could not hand to a neighbouring arc, because the
      // radius is genuinely changing across it, becomes a transition arc of its
      // own.  Runs second so the cheaper answer — no primitive at all — always
      // gets first refusal.
      ["snapAdjacentJunctions", () => {
        conn = snapAdjacentJunctions(recon);
      }],
      ["refit 1", () => refitPoorSpans(recon, conn, ch.denseVerts, ch.pixelsPerVert, ch.vertStats, opts)],
      // Cut off any false concavity the DP left between two same-handed arcs.
      // Runs after G1 so the joints it inspects are the settled ones.
      ["relaxCuspsToLine", () => relaxCuspsToLine(recon, ch.pixelsPerVert, ch.denseVerts)],
      // Re-snap after G1: intersection adjustment can move an endpoint slightly
      // off an axis-aligned position that the earlier snap had established.
      ["axis 3", () => snapAxisAligned(recon, opts.axisSnapPx ?? 1)],
      ["stitch 3", () => stitchJunctions(recon)],
      // Final merge: G1 junction adjustment can make adjacent segments more
      // collinear (or reduce a stub to near-zero length).  One more pass absorbs
      // any remaining redundant vertices.
      ["merge 3", () => mergeCollinearSegments(recon, ch.denseVerts, ch.vertStats, opts.denseSeg ?? 2, opts.mdlPenalty, opts.maxCenteringError)],
      // Again, last.  The merge passes above can absorb the very vertices the
      // first re-fit added — a re-fitted corner came back square because the
      // final merge undid it — and nothing after this point can.
      ["refit 2", () => refitPoorSpans(recon, [], ch.denseVerts, ch.pixelsPerVert, ch.vertStats, opts)],
      ["closed seam", () => {
        if (isClosed) mergeClosedChainSeam(recon, ch.denseVerts, ch.vertStats);
        if (isClosed) closeChainSeam(recon, 20);
      }]
    ];
    opts.passProbe?.({ name: "fitDenseChain", chain: ci, recon, denseVerts: ch.denseVerts });
    for (const [name, run] of passes) {
      if (opts.passFilter && !opts.passFilter(name)) continue;
      run();
      opts.passProbe?.({ name, chain: ci, recon, denseVerts: ch.denseVerts });
    }
    reconByChain.push(recon);
    chainInfos.push({ startVi, endVi, layer, isClosed });
  }
  const tail = (name, run) => {
    if (opts.passFilter && !opts.passFilter(name)) return;
    run();
    if (!opts.passProbe) return;
    for (let ci = 0; ci < reconByChain.length; ci++) {
      const recon = reconByChain[ci];
      if (recon) {
        opts.passProbe({ name, chain: ci, recon, denseVerts: cache.chains[ci].denseVerts });
      }
    }
  };
  const absorbedChains = /* @__PURE__ */ new Set();
  if (opts.postUndashMaxGap && opts.postUndashMaxGap > 0) {
    tail("postFitUndash", () => postFitUndash(
      graph,
      cache,
      chainInfos,
      reconByChain,
      opts,
      opts.postUndashMaxGap,
      opts.postUndashMaxAngleDeg ?? 30,
      absorbedChains
    ));
  }
  tail(
    "snapJunctionEndpoints",
    () => snapJunctionEndpoints(graph, chainInfos, reconByChain, 30, opts.junctionStubMaxPx ?? 0)
  );
  tail("snapEndpointPairs", () => snapEndpointPairs(graph, chainInfos, reconByChain, 30));
  if (opts.taperCollapseMaxStubPx && opts.taperCollapseMaxStubPx > 0) {
    tail("collapseJunctionTapers", () => collapseJunctionTapers(
      graph,
      chainInfos,
      reconByChain,
      opts.taperCollapseMaxStubPx,
      opts.taperCollapseMaxParallelSin ?? 0.15
    ));
  }
  tail("recenterOnSkeleton", () => recenterOnSkeleton(reconByChain, cache, 100, chainInfos, graph));
  tail("recentreAxisAligned", () => recentreAxisAligned(reconByChain, cache, 1.5));
  tail(
    "recentreLongLines",
    () => recentreLongLines(reconByChain, cache, freezeMinLenPx || 100, 1.5)
  );
  tail("stitch tail", () => {
    for (const recon of reconByChain) {
      if (recon) stitchJunctions(recon);
    }
  });
  tail(
    "snapJunctionEndpoints 2",
    () => snapJunctionEndpoints(graph, chainInfos, reconByChain, 30, 0)
  );
  tail("snapEndpointPairs 2", () => snapEndpointPairs(graph, chainInfos, reconByChain, 30));
  if (outValidation) {
    const coverThreshold = (opts.denseSeg ?? 2) * 3;
    outValidation.result = computeFitValidation(
      cache,
      reconByChain,
      absorbedChains,
      opts.denseSeg ?? 2,
      coverThreshold
    );
  }
  const keptByChain = new Array(total).fill(null);
  for (let ci = 0; ci < total; ci++) {
    const recon = reconByChain[ci];
    if (!recon) continue;
    const info = chainInfos[ci];
    const vs = cache.chains[ci].vertStats;
    const nVerts = cache.chains[ci].denseVerts.length;
    const pixCount = (s) => {
      let n = 0;
      if (s.wi <= s.wj) {
        for (let vi = s.wi; vi <= s.wj; vi++) n += vs[vi * 6];
      } else {
        for (let vi = s.wi; vi < nVerts; vi++) n += vs[vi * 6];
        for (let vi = 0; vi <= s.wj; vi++) n += vs[vi * 6];
      }
      return n;
    };
    const isDegenerate = (s) => {
      if (s.prim.type !== "line") return false;
      const len = Math.hypot(s.prim.x2 - s.prim.x1, s.prim.y2 - s.prim.y1);
      if (len < denseSeg) return true;
      if (len < denseSeg * 3 && pixCount(s) <= 2) return true;
      return false;
    };
    const keep = recon.map((s) => !isDegenerate(s));
    const projectExtend = (p, tx, ty, atEnd) => {
      const dx = p.x2 - p.x1, dy = p.y2 - p.y1;
      const len = Math.hypot(dx, dy);
      if (len < 1e-10) return;
      const ux = dx / len, uy = dy / len;
      const t = (tx - p.x1) * ux + (ty - p.y1) * uy;
      if (atEnd && t > len) {
        p.x2 = p.x1 + t * ux;
        p.y2 = p.y1 + t * uy;
      }
      if (!atEnd && t < 0) {
        p.x1 = p.x1 + t * ux;
        p.y1 = p.y1 + t * uy;
      }
    };
    for (let i = 0; i < recon.length; i++) {
      if (keep[i]) continue;
      const s = recon[i];
      let prevKept = -1;
      for (let j = i - 1; j >= 0; j--) {
        if (keep[j]) {
          prevKept = j;
          break;
        }
      }
      if (prevKept >= 0) {
        const prev = recon[prevKept];
        const sEnd = primitiveEndPoint(s.prim, false);
        if (prev.prim.type === "line") projectExtend(prev.prim, sEnd.x, sEnd.y, true);
        prev.wj = s.wj;
        continue;
      }
      let nextKept = -1;
      for (let j = i + 1; j < recon.length; j++) {
        if (keep[j]) {
          nextKept = j;
          break;
        }
      }
      if (nextKept >= 0) {
        const next = recon[nextKept];
        const sStart = primitiveEndPoint(s.prim, true);
        if (next.prim.type === "line") projectExtend(next.prim, sStart.x, sStart.y, false);
        next.wi = s.wi;
      }
    }
    const kept = recon.filter((_, i) => keep[i]);
    weldChainJunctions(kept, info.isClosed, (opts.denseSeg ?? 2) * 8);
    keptByChain[ci] = kept;
  }
  const probeKept = (name) => {
    if (!opts.passProbe) return;
    for (let ci = 0; ci < keptByChain.length; ci++) {
      const kept = keptByChain[ci];
      if (kept) {
        opts.passProbe({ name, chain: ci, recon: kept, denseVerts: cache.chains[ci].denseVerts });
      }
    }
  };
  const tailKept = (name, run) => {
    if (opts.passFilter && !opts.passFilter(name)) return;
    run();
    probeKept(name);
  };
  probeKept("drop stubs + weld");
  tailKept(
    "weldCrossChainJunctions",
    () => weldCrossChainJunctions(keptByChain, chainInfos, (opts.denseSeg ?? 2) * 3)
  );
  tailKept("dropIsolatedSpecks", () => dropIsolatedSpecks(keptByChain, DEFAULT_SPECK_MAX_PX));
  tailKept("consolidateCircles", () => {
    for (const c of consolidateCircles(keptByChain, chainInfos)) {
      segments.push({ layer: c.layer, chainId: c.chainId, isClosed: true, primitive: c.primitive });
    }
  });
  if (opts.extendToOtherInkPx && opts.extendToOtherInkPx > 0) {
    tailKept(
      "extendEndsToOtherInk",
      () => extendEndsToOtherInk(keptByChain, chainInfos, opts.extendToOtherInkPx)
    );
  }
  for (let ci = 0; ci < total; ci++) {
    const kept = keptByChain[ci];
    if (!kept) continue;
    const info = chainInfos[ci];
    for (const s of kept) {
      segments.push({ layer: info.layer, chainId: ci, isClosed: info.isClosed, primitive: s.prim });
    }
  }
  onProgress?.(1, "Done");
  return { width, height, layerCount, segments };
}
function curveGraphToPathGraph(curves, arcStep) {
  const { width, height, layerCount, segments } = curves;
  const vertices = [];
  const edges = [];
  const boundaryVtxMap = /* @__PURE__ */ new Map();
  function addVertex(x, y, layer, type, deduplicate = false) {
    if (deduplicate) {
      const key = `${Math.round(x * 2)},${Math.round(y * 2)},${layer}`;
      const existing = boundaryVtxMap.get(key);
      if (existing !== void 0) return existing;
      const idx2 = vertices.length;
      vertices.push({ x, y, layer, type });
      boundaryVtxMap.set(key, idx2);
      return idx2;
    }
    const idx = vertices.length;
    vertices.push({ x, y, layer, type });
    return idx;
  }
  function addEdge(from, to, layer) {
    if (from === to) return;
    edges.push({ from: Math.min(from, to), to: Math.max(from, to), layer });
  }
  const byChain = /* @__PURE__ */ new Map();
  for (const seg of segments) {
    const arr = byChain.get(seg.chainId);
    if (arr) arr.push(seg);
    else byChain.set(seg.chainId, [seg]);
  }
  for (const chainSegs of byChain.values()) {
    const isClosed = chainSegs[0].isClosed;
    const layer = chainSegs[0].layer;
    if (chainSegs.length === 1 && chainSegs[0].primitive.type === "circle") {
      const { cx, cy, r } = chainSegs[0].primitive;
      const circumference = 2 * Math.PI * r;
      const steps = Math.max(3, Math.ceil(circumference / arcStep));
      const dTheta = 2 * Math.PI / steps;
      const first = addVertex(cx + r, cy, layer, "endpoint");
      let prev = first;
      for (let s = 1; s < steps; s++) {
        const theta = s * dTheta;
        const curr = addVertex(cx + r * Math.cos(theta), cy + r * Math.sin(theta), layer, "chain");
        addEdge(prev, curr, layer);
        prev = curr;
      }
      addEdge(prev, first, layer);
      continue;
    }
    let prevEndIdx = -1;
    const firstStartIdx_ref = { idx: -1 };
    for (let si = 0; si < chainSegs.length; si++) {
      const seg = chainSegs[si];
      const p = seg.primitive;
      if (p.type === "circle") continue;
      const isFirstSeg = si === 0;
      const isLastSeg = si === chainSegs.length - 1;
      const startType = "endpoint";
      const endType = "endpoint";
      if (p.type === "line") {
        let startIdx;
        if (prevEndIdx >= 0) {
          startIdx = prevEndIdx;
        } else {
          startIdx = addVertex(
            p.x1,
            p.y1,
            layer,
            startType,
            /*deduplicate=*/
            isFirstSeg
          );
          if (isFirstSeg) firstStartIdx_ref.idx = startIdx;
        }
        const endIdx = isClosed && isLastSeg && firstStartIdx_ref.idx >= 0 ? firstStartIdx_ref.idx : addVertex(
          p.x2,
          p.y2,
          layer,
          endType,
          /*deduplicate=*/
          isLastSeg
        );
        addEdge(startIdx, endIdx, layer);
        prevEndIdx = endIdx;
      } else {
        const { cx, cy, r, startAngle, endAngle, ccw, sweep } = p;
        const span = ccw ? sweep : -sweep;
        const arcLen = sweep * r;
        const steps = Math.max(1, Math.ceil(arcLen / arcStep));
        const dTheta = span / steps;
        const arcStartX = cx + r * Math.cos(startAngle);
        const arcStartY = cy + r * Math.sin(startAngle);
        const arcEndX = cx + r * Math.cos(endAngle);
        const arcEndY = cy + r * Math.sin(endAngle);
        let startIdx;
        if (prevEndIdx >= 0) {
          startIdx = prevEndIdx;
        } else {
          startIdx = addVertex(arcStartX, arcStartY, layer, startType);
          if (isFirstSeg) firstStartIdx_ref.idx = startIdx;
        }
        let prev = startIdx;
        for (let s = 1; s <= steps; s++) {
          const isLastStep = s === steps;
          let curr;
          if (isLastStep) {
            if (isClosed && isLastSeg && firstStartIdx_ref.idx >= 0) {
              curr = firstStartIdx_ref.idx;
            } else {
              curr = addVertex(arcEndX, arcEndY, layer, endType);
            }
          } else {
            const theta = startAngle + s * dTheta;
            curr = addVertex(cx + r * Math.cos(theta), cy + r * Math.sin(theta), layer, "chain");
          }
          addEdge(prev, curr, layer);
          prev = curr;
        }
        prevEndIdx = prev;
      }
    }
  }
  return { width, height, layerCount, vertices, edges };
}
function densifyChain(chain, verts, segLen) {
  const numEdges = chain.vertices.length - 1 + (chain.isClosed ? 1 : 0);
  if (numEdges === 0) return [];
  const result = [];
  const v0 = verts[chain.vertices[0]];
  result.push({ x: v0.x, y: v0.y });
  let leftover = segLen;
  for (let ei = 0; ei < numEdges; ei++) {
    const aIdx = chain.vertices[ei];
    const bIdx = ei < chain.vertices.length - 1 ? chain.vertices[ei + 1] : chain.vertices[0];
    const va = verts[aIdx], vb = verts[bIdx];
    const dx = vb.x - va.x, dy = vb.y - va.y;
    const edgeLen = Math.hypot(dx, dy);
    if (edgeLen < 1e-10) continue;
    const ux = dx / edgeLen, uy = dy / edgeLen;
    let t = leftover;
    while (t <= edgeLen) {
      result.push({ x: va.x + t * ux, y: va.y + t * uy });
      t += segLen;
    }
    leftover = t - edgeLen;
  }
  return result;
}
async function buildFitCache(device, graph, decomp, bandWidth, denseSeg, onProgress) {
  const layerPixels = await readAllLayers(device, decomp);
  const chains = extractChains(graph);
  const { vertices, width, height, layerCount } = graph;
  const total = chains.length;
  let lastYield = performance.now();
  const chainDenseVerts = [];
  for (let ci = 0; ci < total; ci++) {
    chainDenseVerts.push(densifyChain(chains[ci], vertices, denseSeg));
    const now2 = performance.now();
    if (now2 - lastYield > 16) {
      onProgress?.(ci / total * 0.25, `Densifying chains\u2026 ${Math.round(ci / total * 100)}%`);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  const pixelsPerChainVert = chainDenseVerts.map((dv) => Array.from({ length: dv.length }, () => []));
  const layerVerts = Array.from({ length: layerCount }, () => []);
  for (let ci = 0; ci < total; ci++) {
    const layer = chains[ci].layer;
    const dv = chainDenseVerts[ci];
    for (let vi = 0; vi < dv.length; vi++) {
      layerVerts[layer].push({ ci, vi, x: dv[vi].x, y: dv[vi].y });
    }
  }
  const bw2 = bandWidth * bandWidth;
  for (let layer = 0; layer < layerCount; layer++) {
    const verts = layerVerts[layer];
    if (verts.length === 0) continue;
    const layerPx = layerPixels[layer] ?? new Uint8Array(0);
    let vxMin = Infinity, vxMax = -Infinity, vyMin = Infinity, vyMax = -Infinity;
    for (const v of verts) {
      if (v.x < vxMin) vxMin = v.x;
      if (v.x > vxMax) vxMax = v.x;
      if (v.y < vyMin) vyMin = v.y;
      if (v.y > vyMax) vyMax = v.y;
    }
    const cellSize = bandWidth;
    const originX = vxMin - bandWidth;
    const originY = vyMin - bandWidth;
    const gridW = Math.ceil((vxMax - vxMin + 2 * bandWidth) / cellSize) + 1;
    const gridH = Math.ceil((vyMax - vyMin + 2 * bandWidth) / cellSize) + 1;
    const grid = Array.from({ length: gridW * gridH }, () => []);
    for (let gi = 0; gi < verts.length; gi++) {
      const gx = Math.floor((verts[gi].x - originX) / cellSize);
      const gy = Math.floor((verts[gi].y - originY) / cellSize);
      if (gx >= 0 && gx < gridW && gy >= 0 && gy < gridH) grid[gy * gridW + gx].push(gi);
    }
    const xMin = Math.max(0, Math.floor(vxMin - bandWidth));
    const xMax = Math.min(width - 1, Math.ceil(vxMax + bandWidth));
    const yMin = Math.max(0, Math.floor(vyMin - bandWidth));
    const yMax = Math.min(height - 1, Math.ceil(vyMax + bandWidth));
    for (let y = yMin; y <= yMax; y++) {
      for (let x = xMin; x <= xMax; x++) {
        if (!layerPx[y * width + x]) continue;
        const gcx = Math.floor((x - originX) / cellSize);
        const gcy = Math.floor((y - originY) / cellSize);
        let nearestGI = -1, nearestD2 = bw2;
        for (let dgx = -1; dgx <= 1; dgx++) {
          for (let dgy = -1; dgy <= 1; dgy++) {
            const nx = gcx + dgx, ny = gcy + dgy;
            if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
            for (const gi of grid[ny * gridW + nx]) {
              const v = verts[gi];
              const ddx = x - v.x, ddy = y - v.y;
              const d2 = ddx * ddx + ddy * ddy;
              if (d2 < nearestD2) {
                nearestD2 = d2;
                nearestGI = gi;
              }
            }
          }
        }
        if (nearestGI >= 0) {
          const { ci, vi } = verts[nearestGI];
          pixelsPerChainVert[ci][vi].push({ x, y });
        }
      }
    }
    const now2 = performance.now();
    if (now2 - lastYield > 16) {
      const pct = Math.round((layer + 1) / layerCount * 100);
      onProgress?.(0.25 + (layer + 1) / layerCount * 0.75, `Assigning pixels\u2026 ${pct}%`);
      await new Promise((r) => setTimeout(r, 0));
      lastYield = performance.now();
    }
  }
  const cacheChains = [];
  for (let ci = 0; ci < total; ci++) {
    const chain = chains[ci];
    const denseVerts = chainDenseVerts[ci];
    const pixelsPerVert = pixelsPerChainVert[ci];
    const n = denseVerts.length;
    if (!chain.isClosed && n >= 2) {
      {
        const v = denseVerts[0], next = denseVerts[1];
        const dx = next.x - v.x, dy = next.y - v.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-10) {
          const ux = dx / len, uy = dy / len, lo = -denseSeg * 0.5;
          pixelsPerVert[0] = pixelsPerVert[0].filter(
            (p) => (p.x - v.x) * ux + (p.y - v.y) * uy >= lo
          );
        }
      }
      {
        const v = denseVerts[n - 1], prev = denseVerts[n - 2];
        const dx = v.x - prev.x, dy = v.y - prev.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-10) {
          const ux = dx / len, uy = dy / len, hi = denseSeg * 0.5;
          pixelsPerVert[n - 1] = pixelsPerVert[n - 1].filter(
            (p) => (p.x - v.x) * ux + (p.y - v.y) * uy <= hi
          );
        }
      }
    }
    const vertStats = new Float64Array(n * 6);
    for (let vi = 0; vi < n; vi++) {
      const b = vi * 6, px = pixelsPerVert[vi];
      vertStats[b] = px.length;
      for (const p of px) {
        vertStats[b + 1] += p.x;
        vertStats[b + 2] += p.y;
        vertStats[b + 3] += p.x * p.x;
        vertStats[b + 4] += p.x * p.y;
        vertStats[b + 5] += p.y * p.y;
      }
    }
    cacheChains.push({ layer: chain.layer, isClosed: chain.isClosed, denseVerts, pixelsPerVert, vertStats });
  }
  onProgress?.(1, "Done");
  return { graph, chains: cacheChains };
}

// src/gpu/path_undash.ts
var LOOK_BACK_DIST = 20;
var BURR_MAX_LENGTH = 6;
var BURR_DOT_THRESH = -0.5;
function dist(ax, ay, bx, by) {
  const dx = ax - bx, dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}
function recomputeTypes(verts, adj) {
  for (let i = 0; i < verts.length; i++) {
    const d = adj[i].length;
    verts[i].type = d === 0 ? "isolated" : d === 1 ? "endpoint" : d === 2 ? "chain" : "junction";
  }
}
function buildAdj2(n, edgs) {
  const adj = Array.from({ length: n }, () => []);
  for (const e of edgs) {
    adj[e.from].push(e.to);
    adj[e.to].push(e.from);
  }
  return adj;
}
function remapEdges(edgs, oldToNew) {
  return edgs.map((e) => ({ from: oldToNew[e.from], to: oldToNew[e.to], layer: e.layer }));
}
function trimBurrs(verts, edgs) {
  let v = verts.map((x) => ({ ...x }));
  let e = edgs.map((x) => ({ ...x }));
  for (let pass = 0; pass < 100; pass++) {
    const adj = buildAdj2(v.length, e);
    const removeVerts = /* @__PURE__ */ new Set();
    for (let i = 0; i < v.length; i++) {
      if (adj[i].length !== 1) continue;
      if (removeVerts.has(i)) continue;
      const n = adj[i][0];
      if (adj[n].length !== 2) continue;
      if (dist(v[i].x, v[i].y, v[n].x, v[n].y) >= BURR_MAX_LENGTH) continue;
      const p = adj[n].find((x) => x !== i);
      if (p === void 0) continue;
      const nEx = v[i].x - v[n].x, nEy = v[i].y - v[n].y;
      const nPx = v[p].x - v[n].x, nPy = v[p].y - v[n].y;
      const lenNE = Math.sqrt(nEx * nEx + nEy * nEy);
      const lenNP = Math.sqrt(nPx * nPx + nPy * nPy);
      if (lenNE < 1e-3 || lenNP < 1e-3) continue;
      const dotProd = (nEx * nPx + nEy * nPy) / (lenNE * lenNP);
      if (dotProd <= BURR_DOT_THRESH) continue;
      removeVerts.add(i);
    }
    if (removeVerts.size === 0) break;
    e = e.filter((edge) => !removeVerts.has(edge.from) && !removeVerts.has(edge.to));
    const oldToNew = new Int32Array(v.length).fill(-1);
    let ni = 0;
    v = v.filter((_, idx) => {
      if (removeVerts.has(idx)) return false;
      oldToNew[idx] = ni++;
      return true;
    });
    e = remapEdges(e, oldToNew);
    const newAdj = buildAdj2(v.length, e);
    recomputeTypes(v, newAdj);
  }
  return { verts: v, edgs: e };
}
function lookBackPoint(verts, adj, from, via) {
  const sv = verts[from];
  let prev = from, curr = via;
  let px = sv.x, py = sv.y;
  let traveled = 0;
  for (; ; ) {
    const cv = verts[curr];
    const step = dist(px, py, cv.x, cv.y);
    if (traveled + step >= LOOK_BACK_DIST) {
      const t = step > 1e-9 ? (LOOK_BACK_DIST - traveled) / step : 1;
      return { x: px + t * (cv.x - px), y: py + t * (cv.y - py) };
    }
    traveled += step;
    px = cv.x;
    py = cv.y;
    if (adj[curr].length !== 2) break;
    let next = -1;
    for (const n of adj[curr]) {
      if (n !== prev) {
        next = n;
        break;
      }
    }
    if (next === -1) break;
    prev = curr;
    curr = next;
  }
  return { x: px, y: py };
}
function computeOutwardDir(verts, adj, epIdx) {
  const first = adj[epIdx][0];
  if (first === void 0) return { x: 0, y: 0 };
  const ev = verts[epIdx];
  const ref = lookBackPoint(verts, adj, epIdx, first);
  const dx = ev.x - ref.x, dy = ev.y - ref.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}
function continuationDir(verts, adj, vi, via) {
  const sv = verts[vi];
  const ref = lookBackPoint(verts, adj, vi, via);
  const dx = ref.x - sv.x, dy = ref.y - sv.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return { x: 0, y: 0 };
  return { x: dx / len, y: dy / len };
}
function bridgeGaps(verts, edgs, maxGap, loosestCos) {
  const MAX_BOW_PX = 2;
  const MAX_TURN = Math.acos(Math.max(-1, Math.min(1, loosestCos)));
  const maxTangentAngle = (gap) => Math.min(MAX_TURN, 2 * Math.atan(2 * MAX_BOW_PX / Math.max(gap, 1e-6)));
  const adj = buildAdj2(verts.length, edgs);
  const epIndices = [];
  for (let i = 0; i < verts.length; i++) {
    if (adj[i].length === 1) epIndices.push(i);
  }
  const outDirs = epIndices.map((ep) => computeOutwardDir(verts, adj, ep));
  const candidates = [];
  for (let a = 0; a < epIndices.length; a++) {
    const ai = epIndices[a];
    const va = verts[ai];
    const da = outDirs[a];
    if (da.x === 0 && da.y === 0) continue;
    for (let b = a + 1; b < epIndices.length; b++) {
      const bi = epIndices[b];
      if (verts[bi].layer !== va.layer) continue;
      const vb = verts[bi];
      const db2 = outDirs[b];
      if (db2.x === 0 && db2.y === 0) continue;
      const gapDist = dist(va.x, va.y, vb.x, vb.y);
      if (gapDist > maxGap || gapDist < 0.01) continue;
      const gx = (vb.x - va.x) / gapDist;
      const gy = (vb.y - va.y) / gapDist;
      const cosLimit = Math.cos(maxTangentAngle(gapDist));
      if (da.x * gx + da.y * gy < cosLimit) continue;
      if (db2.x * -gx + db2.y * -gy < cosLimit) continue;
      candidates.push({ ai: a, bi: b, gapDist });
    }
  }
  candidates.sort((x, y) => x.gapDist - y.gapDist);
  const matched = /* @__PURE__ */ new Set();
  const newVerts = verts.map((v) => ({ ...v }));
  const newEdges = [];
  for (const { ai, bi } of candidates) {
    if (matched.has(ai) || matched.has(bi)) continue;
    matched.add(ai);
    matched.add(bi);
    const epA = epIndices[ai];
    const epB = epIndices[bi];
    newEdges.push({
      from: Math.min(epA, epB),
      to: Math.max(epA, epB),
      layer: verts[epA].layer
    });
    newVerts[epA].type = "chain";
    newVerts[epB].type = "chain";
  }
  const isFree = (i) => adj[i].length === 1;
  const attaches = [];
  for (let a = 0; a < epIndices.length; a++) {
    if (matched.has(a)) continue;
    const ai = epIndices[a];
    const va = verts[ai];
    const da = outDirs[a];
    if (da.x === 0 && da.y === 0) continue;
    for (let j = 0; j < verts.length; j++) {
      if (j === ai || isFree(j) || adj[j].length === 0) continue;
      const vj = verts[j];
      if (vj.layer !== va.layer) continue;
      const gapDist = dist(va.x, va.y, vj.x, vj.y);
      if (gapDist > maxGap || gapDist < 0.01) continue;
      const gx = (vj.x - va.x) / gapDist, gy = (vj.y - va.y) / gapDist;
      const cosLimit = Math.cos(maxTangentAngle(gapDist));
      if (da.x * gx + da.y * gy < cosLimit) continue;
      let carriesOn = false, headsBack = false;
      for (const nb of adj[j]) {
        const dj = continuationDir(verts, adj, j, nb);
        if (dj.x === 0 && dj.y === 0) continue;
        if (dj.x * gx + dj.y * gy >= cosLimit) carriesOn = true;
        if (dj.x * -gx + dj.y * -gy >= cosLimit) headsBack = true;
      }
      if (!carriesOn || headsBack) continue;
      attaches.push({ epIdx: a, target: j, gapDist });
    }
  }
  attaches.sort((x, y) => x.gapDist - y.gapDist);
  const usedTargets = /* @__PURE__ */ new Set();
  for (const { epIdx, target } of attaches) {
    if (matched.has(epIdx) || usedTargets.has(target)) continue;
    matched.add(epIdx);
    usedTargets.add(target);
    const ep = epIndices[epIdx];
    newEdges.push({
      from: Math.min(ep, target),
      to: Math.max(ep, target),
      layer: verts[ep].layer
    });
    newVerts[ep].type = "chain";
    newVerts[target].type = "junction";
  }
  return { verts: newVerts, edgs: [...edgs, ...newEdges] };
}
function undashPaths(graph, maxGap, maxAngleDeg) {
  const maxAngleCos = Math.cos(maxAngleDeg * Math.PI / 180);
  const { verts: trimmedV, edgs: trimmedE } = trimBurrs(
    graph.vertices.map((v) => ({ ...v })),
    graph.edges.map((e) => ({ ...e }))
  );
  const { verts: finalV, edgs: finalE } = bridgeGaps(
    trimmedV,
    trimmedE,
    maxGap,
    maxAngleCos
  );
  return {
    width: graph.width,
    height: graph.height,
    layerCount: graph.layerCount,
    vertices: finalV,
    edges: finalE
  };
}

// src/gpu/pipeline_defaults.ts
var DEFAULT_SIMPLIFY_TOL = 1.5;
var DEFAULT_SPUR_MAX = 8;
var DEFAULT_UNDASH_MAX_GAP = 35;
var DEFAULT_UNDASH_MAX_ANGLE = 60;
var DEFAULT_FIT_OPTS = {
  /** Max allowed perpendicular distance from skeleton pixel to fitted primitive. */
  maxCenteringError: 0.5,
  /** Fitted arc radius below this (px) is demoted to a line segment. */
  minArcRadius: 15,
  /**
   * Arc must reduce centering error to ≤ this fraction of the line error to be
   * preferred (single-edge heuristic before MDL scoring).
   */
  arcBenefit: 0.85,
  /** Pixel collection radius: pixels within this distance of the skeleton edge are included. */
  bandWidth: 6,
  /** Minimum pixel count required to attempt fitting on a chain. */
  minPoints: 5,
  /** Arc tessellation step (px) — controls overlay rendering resolution. */
  arcStep: 2,
  /** MDL penalty per segment in the DP fit — the cost of adding a primitive. */
  mdlPenalty: 3,
  /** Dense skeleton resampling step (px) for pixel collection and centring. */
  denseSeg: 2,
  /** Axis-alignment snap radius (px): segments within this angle of H/V are snapped. */
  axisSnapPx: 1,
  /**
   * Freeze a fitted line's direction once it is this long (px) and sits this
   * squarely on its ink, so the passes that close junctions move the other
   * side.  See `freezeConfidentLines`.
   *
   * 100 px is half an inch at 200 dpi.  The damage this exists to stop is a
   * fraction of a degree of rotation, which is invisible on anything short and
   * is 2 px of drift on a long wall, so a generous bar is the right instinct —
   * but 200 was too generous to catch the defect the mechanism was built for,
   * which lives on a 108 px horizontal.
   *
   * Swept over 16 pages of two plan sets: 200 leaves chains over 2 px at 102
   * (from 101) and 60 at 102, while 100 takes it to 100.  Segment count rises
   * 0.5-0.8% at every setting and kinks by 2-4, so this is a shallow optimum
   * rather than a peak, and the reason to prefer 100 is that it covers the
   * lengths where a wall's cut position is at stake.
   */
  freezeMinLenPx: 100,
  /** Centring error (px) a line must be under to be frozen. */
  freezeMaxCE: 0.25,
  /**
   * Post-undash gap closing: maximum gap (px) between fitted segment endpoints
   * that will be bridged.  Set to 0 to disable.
   */
  postUndashMaxGap: DEFAULT_UNDASH_MAX_GAP * 2,
  // 70
  /**
   * Post-undash gap closing: maximum deviation from collinearity (degrees)
   * when bridging a gap.
   */
  postUndashMaxAngleDeg: 45,
  /**
   * Junction stub pruning: after curve fitting, fitted stubs shorter than
   * this (px) that branch off a junction are removed.
   */
  junctionStubMaxPx: 20,
  /**
   * Taper-junction collapse: remove a short stub at a 3-way junction and
   * extend the two nearly-parallel side chains to meet at the stub's far tip,
   * converting T-junction topology into a sharp-corner closed loop.
   * Stubs up to this many fitted pixels are eligible.
   */
  taperCollapseMaxStubPx: 300,
  /**
   * Run a free chain end forward on to other-ink geometry it crosses within
   * this distance.  6px is about one stroke width at 200dpi, which is the size
   * of the shortfall: a red centreline's ink stops at the EDGE of the black
   * outline it terminates on, so its fitted end lands a half-width short.
   */
  extendToOtherInkPx: 6
};

// src/export/vector_export.ts
function fmt(n, digits = 4) {
  return String(Number(n.toFixed(digits)));
}
function hexColor([r, g, b]) {
  const h = (v) => v.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function sanitizeDxfName(name, fallback) {
  const s = name.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return s.length > 0 ? s : fallback;
}
var ACI_TABLE = [
  [1, [255, 0, 0]],
  // red
  [2, [255, 255, 0]],
  // yellow
  [3, [0, 255, 0]],
  // green
  [4, [0, 255, 255]],
  // cyan
  [5, [0, 0, 255]],
  // blue
  [6, [255, 0, 255]],
  // magenta
  [7, [0, 0, 0]],
  // black/white
  [8, [128, 128, 128]],
  // dark gray
  [9, [192, 192, 192]]
  // light gray
];
function nearestAci([r, g, b]) {
  let best = 7;
  let bestDist = Infinity;
  for (const [aci, [ar, ag, ab]] of ACI_TABLE) {
    const d = (r - ar) ** 2 + (g - ag) ** 2 + (b - ab) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = aci;
    }
  }
  return best;
}
function lineStart(p) {
  return { x: p.x1, y: p.y1 };
}
function lineEnd(p) {
  return { x: p.x2, y: p.y2 };
}
function arcStart(p) {
  return { x: p.cx + p.r * Math.cos(p.startAngle), y: p.cy + p.r * Math.sin(p.startAngle) };
}
function arcEnd(p) {
  return { x: p.cx + p.r * Math.cos(p.endAngle), y: p.cy + p.r * Math.sin(p.endAngle) };
}
function arcSweepMag(p) {
  if (typeof p.sweep === "number" && p.sweep > 0) return p.sweep;
  const twoPi = 2 * Math.PI;
  const d = p.ccw ? p.endAngle - p.startAngle : p.startAngle - p.endAngle;
  return (d % twoPi + twoPi) % twoPi;
}
function orient(prim, reversed) {
  const s = prim.type === "line" ? lineStart(prim) : arcStart(prim);
  const e = prim.type === "line" ? lineEnd(prim) : arcEnd(prim);
  const fwdSweep = prim.type === "arc" && prim.ccw ? 1 : 0;
  return reversed ? { sx: e.x, sy: e.y, ex: s.x, ey: s.y, prim, sweepFlag: fwdSweep === 1 ? 0 : 1 } : { sx: s.x, sy: s.y, ex: e.x, ey: e.y, prim, sweepFlag: fwdSweep };
}
function orientChain(prims) {
  const d2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
  const out = [];
  for (let i = 0; i < prims.length; i++) {
    const fwd = orient(prims[i], false);
    const rev = orient(prims[i], true);
    if (i === 0) {
      if (prims.length === 1) {
        out.push(fwd);
        continue;
      }
      const next = orient(prims[1], false);
      const score = (o) => Math.min(d2(o.ex, o.ey, next.sx, next.sy), d2(o.ex, o.ey, next.ex, next.ey));
      out.push(score(fwd) <= score(rev) ? fwd : rev);
    } else {
      const pen = out[i - 1];
      out.push(
        d2(fwd.sx, fwd.sy, pen.ex, pen.ey) <= d2(rev.sx, rev.sy, pen.ex, pen.ey) ? fwd : rev
      );
    }
  }
  return out;
}
var CHAIN_JOIN_EPS = 1;
function groupByChain(segments) {
  const byChain = /* @__PURE__ */ new Map();
  for (const seg of segments) {
    const arr = byChain.get(seg.chainId);
    if (arr) arr.push(seg);
    else byChain.set(seg.chainId, [seg]);
  }
  return [...byChain.values()];
}
function curveGraphToSvg(graph, options) {
  const { dpi, layers } = options;
  const wIn = fmt(graph.width / dpi, 3);
  const hIn = fmt(graph.height / dpi, 3);
  const chainsByLayer = /* @__PURE__ */ new Map();
  for (const chain of groupByChain(graph.segments)) {
    const layer = chain[0].layer;
    let list = chainsByLayer.get(layer);
    if (!list) chainsByLayer.set(layer, list = []);
    list.push(chain);
  }
  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${wIn}in" height="${hIn}in" viewBox="0 0 ${graph.width} ${graph.height}">`
  );
  parts.push(`<g fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">`);
  for (const layerIdx of [...chainsByLayer.keys()].sort((a, b) => a - b)) {
    const rgb = layers[layerIdx]?.rgb ?? [0, 0, 0];
    parts.push(`<g stroke="${hexColor(rgb)}">`);
    for (const chain of chainsByLayer.get(layerIdx)) {
      if (chain.length === 1 && chain[0].primitive.type === "circle") {
        const c = chain[0].primitive;
        parts.push(`<circle cx="${fmt(c.cx, 2)}" cy="${fmt(c.cy, 2)}" r="${fmt(c.r, 3)}"/>`);
        continue;
      }
      const prims = chain.map((seg) => seg.primitive).filter((p) => p.type !== "circle");
      if (prims.length === 0) continue;
      const oriented = orientChain(prims);
      const d = [];
      let penX = NaN, penY = NaN;
      for (const o of oriented) {
        const disconnected = !Number.isFinite(penX) || Math.hypot(o.sx - penX, o.sy - penY) > CHAIN_JOIN_EPS;
        if (disconnected) d.push(`M ${fmt(o.sx, 2)} ${fmt(o.sy, 2)}`);
        if (o.prim.type === "line") {
          d.push(`L ${fmt(o.ex, 2)} ${fmt(o.ey, 2)}`);
        } else {
          const r = fmt(o.prim.r, 3);
          const largeArc = arcSweepMag(o.prim) > Math.PI ? 1 : 0;
          d.push(`A ${r} ${r} 0 ${largeArc} ${o.sweepFlag} ${fmt(o.ex, 2)} ${fmt(o.ey, 2)}`);
        }
        penX = o.ex;
        penY = o.ey;
      }
      if (chain[0].isClosed) d.push("Z");
      parts.push(`<path d="${d.join(" ")}"/>`);
    }
    parts.push(`</g>`);
  }
  parts.push(`</g>`);
  parts.push(`</svg>`);
  return parts.join("\n") + "\n";
}
var OVERLAY_COLORS = [
  [230, 0, 200],
  // magenta
  [0, 120, 255],
  // blue
  [255, 130, 0],
  // orange
  [0, 170, 90],
  // green
  [150, 60, 255]
  // violet
];
var MAX_BEZIER_ARC = Math.PI / 2;
var ARC_TOL_PX = 0.01;
var ERR_COEFF = 181e-7;
function arcToBeziers(out, cx, cy, r, a0, delta) {
  const maxTheta = r > 0 ? Math.min(MAX_BEZIER_ARC, Math.pow(ARC_TOL_PX / (ERR_COEFF * r), 1 / 6)) : MAX_BEZIER_ARC;
  const n = Math.max(1, Math.ceil(Math.abs(delta) / maxTheta));
  const theta = delta / n;
  const k = 4 / 3 * Math.tan(theta / 4);
  let a = a0;
  for (let i = 0; i < n; i++) {
    const b = a + theta;
    const cosA = Math.cos(a), sinA = Math.sin(a);
    const cosB = Math.cos(b), sinB = Math.sin(b);
    const x1 = cx + r * (cosA - k * sinA), y1 = cy + r * (sinA + k * cosA);
    const x2 = cx + r * (cosB + k * sinB), y2 = cy + r * (sinB - k * cosB);
    const x3 = cx + r * cosB, y3 = cy + r * sinB;
    out.push(
      `${fmt(x1, 3)} ${fmt(y1, 3)} ${fmt(x2, 3)} ${fmt(y2, 3)} ${fmt(x3, 3)} ${fmt(y3, 3)} c`
    );
    a = b;
  }
}
function curveGraphToPdfOverlay(graph, options) {
  const colors = options.colors ?? OVERLAY_COLORS;
  const width = options.strokeWidthPx ?? 1;
  const chainsByLayer = /* @__PURE__ */ new Map();
  for (const chain of groupByChain(graph.segments)) {
    const layer = chain[0].layer;
    let list = chainsByLayer.get(layer);
    if (!list) chainsByLayer.set(layer, list = []);
    list.push(chain);
  }
  if (chainsByLayer.size === 0) return "";
  const ops = [];
  ops.push(`${fmt(width, 3)} w 1 J 1 j`);
  for (const layerIdx of [...chainsByLayer.keys()].sort((a, b) => a - b)) {
    const [r, g, b] = colors[layerIdx % colors.length];
    ops.push(`${fmt(r / 255, 4)} ${fmt(g / 255, 4)} ${fmt(b / 255, 4)} RG`);
    for (const chain of chainsByLayer.get(layerIdx)) {
      if (chain.length === 1 && chain[0].primitive.type === "circle") {
        const c = chain[0].primitive;
        ops.push(`${fmt(c.cx + c.r, 3)} ${fmt(c.cy, 3)} m`);
        arcToBeziers(ops, c.cx, c.cy, c.r, 0, 2 * Math.PI);
        ops.push("h S");
        continue;
      }
      const prims = chain.map((seg) => seg.primitive).filter((p) => p.type !== "circle");
      if (prims.length === 0) continue;
      const oriented = orientChain(prims);
      let penX = NaN, penY = NaN;
      let open = false;
      for (const o of oriented) {
        if (!Number.isFinite(penX) || Math.hypot(o.sx - penX, o.sy - penY) > CHAIN_JOIN_EPS) {
          if (open) ops.push("S");
          ops.push(`${fmt(o.sx, 3)} ${fmt(o.sy, 3)} m`);
          open = true;
        }
        if (o.prim.type === "line") {
          ops.push(`${fmt(o.ex, 3)} ${fmt(o.ey, 3)} l`);
        } else {
          const mag = arcSweepMag(o.prim);
          const a0 = Math.atan2(o.sy - o.prim.cy, o.sx - o.prim.cx);
          arcToBeziers(ops, o.prim.cx, o.prim.cy, o.prim.r, a0, o.sweepFlag === 1 ? mag : -mag);
        }
        penX = o.ex;
        penY = o.ey;
      }
      if (open) {
        if (chain[0].isClosed) ops.push("h");
        ops.push("S");
      }
    }
  }
  return ops.join("\n") + "\n";
}
function curveGraphToDxf(graph, options) {
  const { dpi } = options;
  let maxLayer = options.layers.length - 1;
  for (const seg of graph.segments) if (seg.layer > maxLayer) maxLayer = seg.layer;
  const layers = [];
  for (let i = 0; i <= maxLayer; i++) {
    layers.push(options.layers[i] ?? { name: `Layer ${i + 1}`, rgb: [0, 0, 0] });
  }
  const layerNames = layers.map((l, i) => sanitizeDxfName(l.name, `LAYER_${i + 1}`));
  const nameFor = (idx) => layerNames[idx] ?? `LAYER_${idx + 1}`;
  const rows = [];
  const tag = (code, value) => {
    rows.push(String(code), String(value));
  };
  const MM_PER_IN = 25.4;
  const X = (x) => x / dpi * MM_PER_IN;
  const Y = (y) => (graph.height - y) / dpi * MM_PER_IN;
  const S = (v) => v / dpi * MM_PER_IN;
  const angDeg = (cx, cy, px, py) => {
    const a = Math.atan2(cy - py, px - cx) * 180 / Math.PI;
    return (a % 360 + 360) % 360;
  };
  tag(0, "SECTION");
  tag(2, "HEADER");
  tag(9, "$ACADVER");
  tag(1, "AC1009");
  tag(9, "$INSUNITS");
  tag(70, 4);
  tag(9, "$MEASUREMENT");
  tag(70, 1);
  tag(9, "$LUNITS");
  tag(70, 2);
  tag(9, "$EXTMIN");
  tag(10, 0);
  tag(20, 0);
  tag(30, 0);
  tag(9, "$EXTMAX");
  tag(10, fmt(S(graph.width)));
  tag(20, fmt(S(graph.height)));
  tag(30, 0);
  tag(0, "ENDSEC");
  tag(0, "SECTION");
  tag(2, "TABLES");
  tag(0, "TABLE");
  tag(2, "LAYER");
  tag(70, layers.length);
  for (let i = 0; i < layers.length; i++) {
    tag(0, "LAYER");
    tag(2, nameFor(i));
    tag(70, 0);
    tag(62, nearestAci(layers[i].rgb));
    tag(6, "CONTINUOUS");
  }
  tag(0, "ENDTAB");
  tag(0, "ENDSEC");
  tag(0, "SECTION");
  tag(2, "ENTITIES");
  for (const seg of graph.segments) {
    const layerName = nameFor(seg.layer);
    const p = seg.primitive;
    if (p.type === "line") {
      tag(0, "LINE");
      tag(8, layerName);
      tag(10, fmt(X(p.x1)));
      tag(20, fmt(Y(p.y1)));
      tag(30, 0);
      tag(11, fmt(X(p.x2)));
      tag(21, fmt(Y(p.y2)));
      tag(31, 0);
    } else if (p.type === "circle") {
      tag(0, "CIRCLE");
      tag(8, layerName);
      tag(10, fmt(X(p.cx)));
      tag(20, fmt(Y(p.cy)));
      tag(30, 0);
      tag(40, fmt(S(p.r)));
    } else {
      const s = arcStart(p), e = arcEnd(p);
      const [sx, sy, ex, ey] = p.ccw ? [e.x, e.y, s.x, s.y] : [s.x, s.y, e.x, e.y];
      tag(0, "ARC");
      tag(8, layerName);
      tag(10, fmt(X(p.cx)));
      tag(20, fmt(Y(p.cy)));
      tag(30, 0);
      tag(40, fmt(S(p.r)));
      tag(50, fmt(angDeg(p.cx, p.cy, sx, sy), 3));
      tag(51, fmt(angDeg(p.cx, p.cy, ex, ey), 3));
    }
  }
  tag(0, "ENDSEC");
  tag(0, "EOF");
  return rows.join("\r\n") + "\r\n";
}

// src/export/raster_export.ts
async function deflate(data) {
  const cs = new CompressionStream("deflate");
  const stream = new Blob([data]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
var CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
var enc = new TextEncoder();
var ascii = (s) => enc.encode(s);
var be32 = (v) => new Uint8Array([v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255]);
function indexColors(img) {
  const { width, height, data } = img;
  const map = /* @__PURE__ */ new Map();
  const palette = [];
  const indices = new Uint8Array(width * height);
  for (let i = 0, p = 0; p < indices.length; p++, i += 4) {
    const key = data[i] << 16 | data[i + 1] << 8 | data[i + 2];
    let idx = map.get(key);
    if (idx === void 0) {
      if (palette.length >= 256) return null;
      idx = palette.length;
      palette.push([data[i], data[i + 1], data[i + 2]]);
      map.set(key, idx);
    }
    indices[p] = idx;
  }
  return { width, height, indices, palette };
}
function pngChunk(type, data) {
  const typeBytes = ascii(type);
  const body = concat([typeBytes, data]);
  return concat([be32(data.length), body, be32(crc32(body))]);
}
var PNG_SIG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
async function encodeCleanPng(img) {
  const idx = indexColors(img);
  const { width, height } = img;
  let ihdr;
  let raw;
  const chunks = [];
  if (idx) {
    ihdr = concat([be32(width), be32(height), new Uint8Array([8, 3, 0, 0, 0])]);
    raw = new Uint8Array(height * (width + 1));
    for (let y = 0; y < height; y++) {
      raw[y * (width + 1)] = 0;
      raw.set(idx.indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    }
    const plte = new Uint8Array(idx.palette.length * 3);
    idx.palette.forEach(([r, g, b], i) => {
      plte[i * 3] = r;
      plte[i * 3 + 1] = g;
      plte[i * 3 + 2] = b;
    });
    chunks.push(pngChunk("IHDR", ihdr), pngChunk("PLTE", plte));
  } else {
    ihdr = concat([be32(width), be32(height), new Uint8Array([8, 2, 0, 0, 0])]);
    raw = new Uint8Array(height * (width * 3 + 1));
    const stride = width * 3 + 1;
    for (let y = 0; y < height; y++) {
      raw[y * stride] = 0;
      for (let x = 0; x < width; x++) {
        const s = (y * width + x) * 4, d = y * stride + 1 + x * 3;
        raw[d] = img.data[s];
        raw[d + 1] = img.data[s + 1];
        raw[d + 2] = img.data[s + 2];
      }
    }
    chunks.push(pngChunk("IHDR", ihdr));
  }
  chunks.push(pngChunk("IDAT", await deflate(raw)));
  chunks.push(pngChunk("IEND", new Uint8Array(0)));
  return concat([PNG_SIG, ...chunks]);
}
var hex = (b) => b.toString(16).padStart(2, "0");
var OCG_SCAN = "Cleaned page";
var OCG_VECTORS = "Fitted vectors";
async function encodeCleanPdf(pages) {
  if (pages.length === 0) throw new Error("encodeCleanPdf: no pages");
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogNum = 1, pagesNum = 2;
  objects.push(new Uint8Array(0), new Uint8Array(0));
  const anyOverlay = pages.some((p) => p.overlay);
  const scanOcgNum = anyOverlay ? addObject(ascii(`<< /Type /OCG /Name (${OCG_SCAN}) >>`)) : 0;
  const vectorOcgNum = anyOverlay ? addObject(ascii(`<< /Type /OCG /Name (${OCG_VECTORS}) >>`)) : 0;
  const pageNums = [];
  for (const { image, dpi, overlay } of pages) {
    const idx = indexColors(image);
    const { width, height } = image;
    let colorSpace;
    let sampleBytes;
    if (idx) {
      const lookup = idx.palette.map(([r, g, b]) => `${hex(r)}${hex(g)}${hex(b)}`).join("");
      colorSpace = `[/Indexed /DeviceRGB ${idx.palette.length - 1} <${lookup}>]`;
      sampleBytes = idx.indices;
    } else {
      colorSpace = "/DeviceRGB";
      sampleBytes = new Uint8Array(width * height * 3);
      for (let p = 0, s = 0; p < width * height; p++, s += 4) {
        sampleBytes[p * 3] = image.data[s];
        sampleBytes[p * 3 + 1] = image.data[s + 1];
        sampleBytes[p * 3 + 2] = image.data[s + 2];
      }
    }
    const compressed = await deflate(sampleBytes);
    const imgNum = addObject(concat([
      ascii(
        `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace ${colorSpace} /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>
stream
`
      ),
      compressed,
      ascii("\nendstream")
    ]));
    const wPt = width / dpi * 72, hPt = height / dpi * 72;
    let stream = `q ${wPt.toFixed(4)} 0 0 ${hPt.toFixed(4)} 0 0 cm /Im0 Do Q
`;
    if (anyOverlay) stream = `/OC /ocScan BDC
${stream}EMC
`;
    if (overlay) {
      const s = 72 / dpi;
      stream += `/OC /ocVec BDC
q ${s.toFixed(6)} 0 0 ${(-s).toFixed(6)} 0 ${hPt.toFixed(4)} cm
` + overlay + `Q
EMC
`;
    }
    const content = ascii(stream);
    const contentNum = addObject(concat([
      ascii(`<< /Length ${content.length} >>
stream
`),
      content,
      ascii("endstream")
    ]));
    const properties = anyOverlay ? ` /Properties << /ocScan ${scanOcgNum} 0 R /ocVec ${vectorOcgNum} 0 R >>` : "";
    pageNums.push(addObject(ascii(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${wPt.toFixed(4)} ${hPt.toFixed(4)}] /Resources << /XObject << /Im0 ${imgNum} 0 R >>${properties} >> /Contents ${contentNum} 0 R >>`
    )));
  }
  const ocProperties = anyOverlay ? ` /OCProperties << /OCGs [${scanOcgNum} 0 R ${vectorOcgNum} 0 R] /D << /Order [${scanOcgNum} 0 R ${vectorOcgNum} 0 R] /ON [${scanOcgNum} 0 R ${vectorOcgNum} 0 R] >> >>` : "";
  objects[catalogNum - 1] = ascii(
    `<< /Type /Catalog /Pages ${pagesNum} 0 R${ocProperties} >>`
  );
  objects[pagesNum - 1] = ascii(
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`
  );
  const parts = [];
  let offset = 0;
  const push = (b) => {
    parts.push(b);
    offset += b.length;
  };
  const offsets = [];
  push(ascii("%PDF-1.4\n"));
  push(new Uint8Array([37, 226, 227, 207, 211, 10]));
  for (let i = 0; i < objects.length; i++) {
    offsets.push(offset);
    push(ascii(`${i + 1} 0 obj
`));
    push(objects[i]);
    push(ascii("\nendobj\n"));
  }
  const xrefOffset = offset;
  let xref = `xref
0 ${objects.length + 1}
0000000000 65535 f 
`;
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n 
`;
  push(ascii(xref));
  push(ascii(`trailer
<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>
startxref
${xrefOffset}
%%EOF
`));
  return concat(parts);
}

// browser-app/perf.ts
var profiling = false;
var t0 = 0;
var stages = [];
var longTasks = [];
var frameGaps = [];
var observer = null;
var rafHandle = 0;
var openStage = null;
var env = null;
var notes = [];
var now = () => performance.now();
function note(text) {
  if (profiling) notes.push(text);
}
function noteOnnx(executionProvider, precision) {
  if (env) env.onnx = { executionProvider, precision };
  else pendingOnnx = { executionProvider, precision };
}
var pendingOnnx = null;
async function snapshotEnv() {
  const nav = navigator;
  const mem = performance.memory;
  const snap = {
    userAgent: navigator.userAgent,
    deviceMemoryGb: typeof nav.deviceMemory === "number" ? nav.deviceMemory : null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
    screen: `${globalThis.screen?.width ?? 0}x${globalThis.screen?.height ?? 0}`,
    crossOriginIsolated: !!globalThis.crossOriginIsolated,
    webgpu: { available: false },
    heapUsedMb: mem ? Math.round(mem.usedJSHeapSize / 1e6) : null,
    heapLimitMb: mem ? Math.round(mem.jsHeapSizeLimit / 1e6) : null
  };
  try {
    const gpu = nav.gpu;
    if (gpu) {
      const adapter = await gpu.requestAdapter();
      if (adapter) {
        const a = adapter;
        const info = typeof a.requestAdapterInfo === "function" ? await a.requestAdapterInfo() : a.info;
        snap.webgpu = {
          available: true,
          vendor: info?.vendor || void 0,
          architecture: info?.architecture || void 0,
          device: info?.device || void 0,
          description: info?.description || void 0,
          maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
          maxBufferSize: Number(adapter.limits.maxBufferSize),
          maxStorageBufferBindingSize: Number(adapter.limits.maxStorageBufferBindingSize),
          maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
          isFallbackAdapter: a.isFallbackAdapter ?? a.info?.isFallbackAdapter ?? void 0
        };
      }
    }
  } catch {
  }
  return snap;
}
async function startProfile() {
  stopProfile();
  stages.length = 0;
  longTasks.length = 0;
  frameGaps.length = 0;
  notes = [];
  profiling = true;
  t0 = now();
  env = await snapshotEnv();
  if (pendingOnnx) {
    env.onnx = pendingOnnx;
    pendingOnnx = null;
  }
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks.push({ start: e.startTime, duration: e.duration });
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    observer = null;
  }
  let last = now();
  const tick = () => {
    const t = now();
    const gap = t - last;
    last = t;
    if (gap > 50) frameGaps.push({ at: t - gap, gap });
    rafHandle = requestAnimationFrame(tick);
  };
  rafHandle = requestAnimationFrame(tick);
}
function stopProfile() {
  profiling = false;
  if (openStage) endStage();
  observer?.disconnect();
  observer = null;
  if (rafHandle) cancelAnimationFrame(rafHandle);
  rafHandle = 0;
}
function beginStage(name) {
  if (!profiling) return;
  if (openStage) endStage();
  openStage = { name, startMs: now() };
}
function endStage() {
  if (!openStage) return;
  const { name, startMs } = openStage;
  openStage = null;
  stages.push({
    name,
    startMs,
    endMs: now(),
    longTaskCount: 0,
    longTaskTotalMs: 0,
    longTaskMaxMs: 0,
    worstFrameGapMs: 0
  });
}
function attribute() {
  const out = stages.map((s) => ({ ...s }));
  const overlap = (aStart, aEnd, s) => Math.max(0, Math.min(aEnd, s.endMs) - Math.max(aStart, s.startMs));
  for (const t of longTasks) {
    const end = t.start + t.duration;
    let best = null, bestOv = 0;
    for (const s of out) {
      const ov = overlap(t.start, end, s);
      if (ov <= 0) continue;
      s.longTaskTotalMs += ov;
      if (ov > bestOv) {
        bestOv = ov;
        best = s;
      }
    }
    if (best) {
      best.longTaskCount++;
      best.longTaskMaxMs = Math.max(best.longTaskMaxMs, t.duration);
    }
  }
  for (const g of frameGaps) {
    const end = g.at + g.gap;
    let best = null, bestOv = 0;
    for (const s of out) {
      const ov = overlap(g.at, end, s);
      if (ov > bestOv) {
        bestOv = ov;
        best = s;
      }
    }
    if (best) best.worstFrameGapMs = Math.max(best.worstFrameGapMs, g.gap);
  }
  return out;
}
function getReport() {
  const attributed = attribute();
  const totalMs = attributed.length ? attributed[attributed.length - 1].endMs - attributed[0].startMs : now() - t0;
  const longTaskTotalMs = longTasks.reduce((a, t) => a + t.duration, 0);
  return {
    env,
    notes,
    totalMs,
    stages: attributed,
    longTaskCount: longTasks.length,
    longTaskTotalMs,
    longTaskMaxMs: longTasks.reduce((a, t) => Math.max(a, t.duration), 0),
    worstFrameGapMs: frameGaps.reduce((a, g) => Math.max(a, g.gap), 0),
    blockedFraction: totalMs > 0 ? longTaskTotalMs / totalMs : 0
  };
}
var secs = (ms) => `${(ms / 1e3).toFixed(1)}s`;
function formatReport() {
  const r = getReport();
  const L = [];
  const e = r.env;
  L.push("cleanplans responsiveness report");
  L.push("=".repeat(60));
  if (e) {
    L.push(`UA           ${e.userAgent}`);
    L.push(`screen       ${e.screen} @ dpr ${e.devicePixelRatio}   cores ${e.hardwareConcurrency ?? "?"}   RAM ${e.deviceMemoryGb ?? "?"}GB`);
    L.push(`crossOriginIsolated ${e.crossOriginIsolated}` + (e.heapLimitMb ? `   heap ${e.heapUsedMb}/${e.heapLimitMb}MB` : ""));
    if (e.webgpu.available) {
      const gpuName = [e.webgpu.vendor, e.webgpu.architecture, e.webgpu.device, e.webgpu.description].filter(Boolean).join(" ") || "(browser withheld details)";
      L.push(`WebGPU       ${gpuName}` + (e.webgpu.isFallbackAdapter ? "   *** FALLBACK (software) ADAPTER ***" : ""));
      L.push(`  limits     maxTexture2D ${e.webgpu.maxTextureDimension2D}  maxBuffer ${Math.round((e.webgpu.maxBufferSize ?? 0) / 1e6)}MB  maxStorageBinding ${Math.round((e.webgpu.maxStorageBufferBindingSize ?? 0) / 1e6)}MB`);
    } else {
      L.push("WebGPU       NOT AVAILABLE");
    }
    if (e.onnx) L.push(`denoiser     ${e.onnx.executionProvider} / ${e.onnx.precision}`);
  }
  for (const n of r.notes) L.push(`note         ${n}`);
  L.push("");
  L.push(`total ${secs(r.totalMs)}   blocked ${secs(r.longTaskTotalMs)} (${(r.blockedFraction * 100).toFixed(0)}% of wall clock)`);
  L.push(`worst single block ${secs(r.longTaskMaxMs)}   worst frame gap ${secs(r.worstFrameGapMs)}`);
  L.push("");
  L.push(`${"stage".padEnd(34)}${"wall".padStart(8)}${"blocked".padStart(9)}${"tasks".padStart(7)}${"worst".padStart(8)}${"frame".padStart(8)}`);
  L.push("-".repeat(74));
  for (const s of r.stages) {
    L.push(
      s.name.slice(0, 33).padEnd(34) + secs(s.endMs - s.startMs).padStart(8) + secs(s.longTaskTotalMs).padStart(9) + String(s.longTaskCount).padStart(7) + secs(s.longTaskMaxMs).padStart(8) + secs(s.worstFrameGapMs).padStart(8)
    );
  }
  L.push("-".repeat(74));
  L.push("");
  L.push("worst  = longest single uninterrupted main-thread task in that stage.");
  L.push("frame  = longest gap between animation frames; larger than `worst`");
  L.push("         means something outside JS (GPU, compositor) also stalled.");
  return L.join("\n");
}

// src/gpu/gpu_context.ts
var cachedContext = null;
var initPromise = null;
async function getGPUContext() {
  if (cachedContext) return cachedContext;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const gpu = navigator.gpu;
    if (!gpu) {
      throw new Error("WebGPU is not supported in this browser");
    }
    const adapter = await gpu.requestAdapter();
    if (!adapter) {
      throw new Error("Failed to obtain WebGPU adapter");
    }
    const device = await adapter.requestDevice();
    device.addEventListener("uncapturederror", (event) => {
      const gpuEvent = event;
      console.error("WebGPU uncaptured error:", gpuEvent.error);
    });
    device.lost.then((info) => {
      console.warn(`WebGPU device lost (${info.reason}): ${info.message}`);
      if (cachedContext?.device === device) {
        cachedContext = null;
        initPromise = null;
      }
    });
    cachedContext = { device, adapter };
    initPromise = null;
    return cachedContext;
  })();
  return initPromise;
}

// src/crop/auto_crop.ts
function srgbToLinear2(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function rgbToOklab(r, g, b) {
  const lr = srgbToLinear2(r);
  const lg = srgbToLinear2(g);
  const lb = srgbToLinear2(b);
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  ];
}
function oklabDistance(a, b) {
  const dL = a[0] - b[0];
  const da = a[1] - b[1];
  const db2 = a[2] - b[2];
  return Math.sqrt(dL * dL + da * da + db2 * db2);
}
function findMajorityColor(image, bucketSize = 8) {
  const counts = /* @__PURE__ */ new Map();
  for (let i = 0; i < image.data.length; i += 4) {
    const r = image.data[i];
    const g = image.data[i + 1];
    const b = image.data[i + 2];
    const qr = Math.floor(r / bucketSize);
    const qg = Math.floor(g / bucketSize);
    const qb = Math.floor(b / bucketSize);
    const key = qr << 16 | qg << 8 | qb;
    const entry = counts.get(key);
    if (entry) {
      entry.count++;
      entry.rSum += r;
      entry.gSum += g;
      entry.bSum += b;
    } else {
      counts.set(key, { count: 1, rSum: r, gSum: g, bSum: b });
    }
  }
  let best = { count: 0, rSum: 0, gSum: 0, bSum: 0 };
  for (const entry of counts.values()) {
    if (entry.count > best.count) best = entry;
  }
  if (best.count === 0) return [255, 255, 255];
  return [
    Math.round(best.rSum / best.count),
    Math.round(best.gSum / best.count),
    Math.round(best.bSum / best.count)
  ];
}
var BG_THRESHOLD = 0.06;
function buildPackedMask(image, bgOklab) {
  const { width, height, data } = image;
  const rowStride = Math.ceil(width / 32);
  const words = new Uint32Array(rowStride * height);
  for (let y = 0; y < height; y++) {
    const rowBase = y * rowStride;
    for (let x = 0; x < width; x++) {
      const pidx = (y * width + x) * 4;
      const lab = rgbToOklab(data[pidx], data[pidx + 1], data[pidx + 2]);
      if (oklabDistance(lab, bgOklab) > BG_THRESHOLD) {
        words[rowBase + (x >>> 5)] |= 1 << (x & 31);
      }
    }
  }
  return { words, width, height, rowStride };
}
function mergePackedMasks(masks) {
  if (masks.length === 1) return masks[0];
  const width = Math.min(...masks.map((m) => m.width));
  const height = Math.min(...masks.map((m) => m.height));
  const rowStride = Math.ceil(width / 32);
  const words = new Uint32Array(rowStride * height);
  for (const mask of masks) {
    for (let y = 0; y < height; y++) {
      const dBase = y * rowStride;
      const sBase = y * mask.rowStride;
      for (let w = 0; w < rowStride; w++) {
        words[dBase + w] |= mask.words[sBase + w];
      }
    }
  }
  if (width % 32 !== 0) {
    const lastBits = (1 << width % 32) - 1;
    for (let y = 0; y < height; y++) {
      words[(y + 1) * rowStride - 1] &= lastBits;
    }
  }
  return { words, width, height, rowStride };
}
function popcount32(n) {
  n = n - (n >>> 1 & 1431655765);
  n = (n & 858993459) + (n >>> 2 & 858993459);
  n = n + (n >>> 4) & 252645135;
  return Math.imul(n, 16843009) >>> 24;
}
function findContentBBox(mask) {
  const { words, width, height, rowStride } = mask;
  const rowCounts = new Uint32Array(height);
  const colCounts = new Uint32Array(width);
  for (let y = 0; y < height; y++) {
    const base = y * rowStride;
    for (let w = 0; w < rowStride; w++) {
      const word = words[base + w];
      if (word === 0) continue;
      rowCounts[y] += popcount32(word);
      const xBase = w << 5;
      const xEnd = Math.min(xBase + 32, width);
      for (let x = xBase; x < xEnd; x++) {
        if (word >>> x - xBase & 1) colCounts[x]++;
      }
    }
  }
  const minRowContent = Math.max(3, Math.round(width * 1e-3));
  const minColContent = Math.max(3, Math.round(height * 1e-3));
  let top = 0;
  while (top < height && rowCounts[top] < minRowContent) top++;
  let bottom = height - 1;
  while (bottom > top && rowCounts[bottom] < minRowContent) bottom--;
  let left = 0;
  while (left < width && colCounts[left] < minColContent) left++;
  let right = width - 1;
  while (right > left && colCounts[right] < minColContent) right--;
  if (top > bottom || left > right) {
    return { x: 0, y: 0, width, height };
  }
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
function buildPrefixSums(mask) {
  const { words, width, height, rowStride } = mask;
  const rowPre = new Array(height);
  for (let y = 0; y < height; y++) {
    const rp = new Uint32Array(width + 1);
    const base = y * rowStride;
    for (let x = 0; x < width; x++) {
      rp[x + 1] = rp[x] + (words[base + (x >>> 5)] >>> (x & 31) & 1);
    }
    rowPre[y] = rp;
  }
  const colPre = new Array(width);
  for (let x = 0; x < width; x++) {
    const cp = new Uint32Array(height + 1);
    const wi = x >>> 5;
    const bi = x & 31;
    for (let y = 0; y < height; y++) {
      cp[y + 1] = cp[y] + (words[y * rowStride + wi] >>> bi & 1);
    }
    colPre[x] = cp;
  }
  return { rowPre, colPre };
}
function isBoundaryClean(ps, rx, ry, rw, rh) {
  const { rowPre, colPre } = ps;
  if (rowPre[ry][rx + rw] - rowPre[ry][rx] > 0) return false;
  if (rowPre[ry + rh - 1][rx + rw] - rowPre[ry + rh - 1][rx] > 0) return false;
  if (colPre[rx][ry + rh] - colPre[rx][ry] > 0) return false;
  if (colPre[rx + rw - 1][ry + rh] - colPre[rx + rw - 1][ry] > 0) return false;
  return true;
}
function computeMargin(ps, rx, ry, rw, rh) {
  const { rowPre, colPre } = ps;
  let topMargin = rh;
  for (let y = ry; y < ry + rh; y++) {
    if (rowPre[y][rx + rw] - rowPre[y][rx] > 0) {
      topMargin = y - ry;
      break;
    }
  }
  let bottomMargin = rh;
  for (let y = ry + rh - 1; y >= ry; y--) {
    if (rowPre[y][rx + rw] - rowPre[y][rx] > 0) {
      bottomMargin = ry + rh - 1 - y;
      break;
    }
  }
  let leftMargin = rw;
  for (let x = rx; x < rx + rw; x++) {
    if (colPre[x][ry + rh] - colPre[x][ry] > 0) {
      leftMargin = x - rx;
      break;
    }
  }
  let rightMargin = rw;
  for (let x = rx + rw - 1; x >= rx; x--) {
    if (colPre[x][ry + rh] - colPre[x][ry] > 0) {
      rightMargin = rx + rw - 1 - x;
      break;
    }
  }
  return Math.min(topMargin, bottomMargin, leftMargin, rightMargin);
}
function findMaxMarginPosition(ps, width, height, initX, initY, rw, rh) {
  const maxX = width - rw;
  const maxY = height - rh;
  if (maxX < 0 || maxY < 0) return [Math.max(0, initX), Math.max(0, initY)];
  let bestX = initX;
  let bestY = initY;
  let bestMargin = -1;
  let bestDistSq = Infinity;
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x <= maxX; x++) {
      if (!isBoundaryClean(ps, x, y, rw, rh)) continue;
      const margin = computeMargin(ps, x, y, rw, rh);
      const dSq = (x - initX) ** 2 + (y - initY) ** 2;
      if (margin > bestMargin || margin === bestMargin && dSq < bestDistSq) {
        bestMargin = margin;
        bestX = x;
        bestY = y;
        bestDistSq = dSq;
      }
    }
  }
  return [bestX, bestY];
}
function computeAutoCropFromMasks(masks, targetWidthInches, targetHeightInches, dpi) {
  const combined = mergePackedMasks(masks);
  const contentBBox = findContentBBox(combined);
  const contentAspect = contentBBox.width / contentBBox.height;
  const landscape = contentAspect >= 1;
  const orientation = landscape ? "landscape" : "portrait";
  let targetW = landscape ? Math.round(targetWidthInches * dpi) : Math.round(targetHeightInches * dpi);
  let targetH = landscape ? Math.round(targetHeightInches * dpi) : Math.round(targetWidthInches * dpi);
  targetW = Math.min(targetW, combined.width);
  targetH = Math.min(targetH, combined.height);
  const contentCenterX = contentBBox.x + contentBBox.width / 2;
  const contentCenterY = contentBBox.y + contentBBox.height / 2;
  const initX = Math.max(0, Math.min(combined.width - targetW, Math.round(contentCenterX - targetW / 2)));
  const initY = Math.max(0, Math.min(combined.height - targetH, Math.round(contentCenterY - targetH / 2)));
  const ps = buildPrefixSums(combined);
  const [cropX, cropY] = findMaxMarginPosition(
    ps,
    combined.width,
    combined.height,
    initX,
    initY,
    targetW,
    targetH
  );
  return {
    rect: { x: cropX, y: cropY, width: targetW, height: targetH },
    orientation,
    contentBBox
  };
}
function computeAutoCrop(image, bgColor, targetWidthInches, targetHeightInches, dpi) {
  return computeAutoCropMultiPage(
    [{ image, bgColor }],
    targetWidthInches,
    targetHeightInches,
    dpi
  );
}
function computeAutoCropMultiPage(pages, targetWidthInches, targetHeightInches, dpi) {
  const masks = pages.map(({ image, bgColor }) => {
    const bgOklab = rgbToOklab(bgColor[0], bgColor[1], bgColor[2]);
    return buildPackedMask(image, bgOklab);
  });
  return computeAutoCropFromMasks(masks, targetWidthInches, targetHeightInches, dpi);
}

// wgsl-raw:C:\Users\gauch\code\vectorizor\cleanplans-web\src\gpu\shaders\content_mask.wgsl
var content_mask_default = "// content_mask.wgsl\r\n//\r\n// Classifies every pixel of an RGBA image as background or content and\r\n// writes a 1-bit-per-pixel packed mask (content = 1, background = 0).\r\n//\r\n// Classification uses a 64\xB3 quantised RGB\u2192OKLab lookup table (built once\r\n// on the CPU and uploaded to a GPU storage buffer).  Each LUT entry packs\r\n// OKLab as three u8 values \u2014 the same format as the palette decompose\r\n// shader \u2014 so the per-pixel cost is a single array read plus a few ALU ops\r\n// instead of a full OKLab conversion.\r\n//\r\n// Bindings\r\n// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n//   0 \u2014 texture_2d<f32>   input image (rgba8unorm, values in [0, 1])\r\n//   1 \u2014 uniform Dims       { width, height, rowStride, _pad, bgL, bgA, bgB, threshSq }\r\n//   2 \u2014 storage read       lut[64\xB3]   packed as  bits 7:0  L  [0,1]  \u2192 [0,255]\r\n//                                                bits 15:8  a  [\u22120.4,+0.4] \u2192 [0,255]\r\n//                                                bits 23:16 b  [\u22120.4,+0.4] \u2192 [0,255]\r\n//                                                bits 31:24 unused (0)\r\n//   3 \u2014 storage read_write output     1-bpp packed mask (pre-initialised by shader)\r\n//\r\n// Layout\r\n// \u2500\u2500\u2500\u2500\u2500\u2500\r\n// One workgroup (32 \xD7 1 threads) covers 32 consecutive pixels in one row,\r\n// which is exactly one u32 word in the output mask.\r\n//\r\n//   wordIndex = wgid.y * dims.rowStride + wgid.x\r\n//\r\n// Thread lid.x (= 0\u202631) sets bit lid.x in the shared word if its pixel is\r\n// content.  Thread 0 writes the final word to the output \u2014 no inter-workgroup\r\n// contention because every workgroup owns a unique (column, row) slot.\r\n\r\nconst LUT_DIM:  u32 = 64u;\r\nconst AB_RANGE: f32 = 0.4;\r\n\r\nstruct Dims {\r\n    width:     u32,\r\n    height:    u32,\r\n    rowStride: u32,\r\n    _pad:      u32,\r\n    bgL:       f32,\r\n    bgA:       f32,\r\n    bgB:       f32,\r\n    threshSq:  f32,\r\n}\r\n\r\n@group(0) @binding(0) var inputTex: texture_2d<f32>;\r\n@group(0) @binding(1) var<uniform>             dims:   Dims;\r\n@group(0) @binding(2) var<storage, read>       lut:    array<u32>;\r\n@group(0) @binding(3) var<storage, read_write> output: array<u32>;\r\n\r\n// One packed word per workgroup (32 pixels \u2192 1 u32).\r\nvar<workgroup> wg_word: atomic<u32>;\r\n\r\n@compute @workgroup_size(32, 1)\r\nfn main(\r\n    @builtin(local_invocation_id)    lid:  vec3<u32>,\r\n    @builtin(local_invocation_index) lii:  u32,\r\n    @builtin(global_invocation_id)   gid:  vec3<u32>,\r\n    @builtin(workgroup_id)           wgid: vec3<u32>,\r\n) {\r\n    // \u2500\u2500 Step 1: zero the shared word \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n    if (lii == 0u) { atomicStore(&wg_word, 0u); }\r\n    workgroupBarrier();\r\n\r\n    // \u2500\u2500 Step 2: classify pixel; set bit if content \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n    let x = gid.x;\r\n    let y = gid.y;\r\n\r\n    if (x < dims.width && y < dims.height) {\r\n        let color = textureLoad(inputTex, vec2i(i32(x), i32(y)), 0);\r\n\r\n        // Quantise to 6-bit per channel (>> 2 gives range [0, 63]).\r\n        let r8 = u32(color.x * 255.0 + 0.5);\r\n        let g8 = u32(color.y * 255.0 + 0.5);\r\n        let b8 = u32(color.z * 255.0 + 0.5);\r\n        let lutIdx = (r8 >> 2u) * LUT_DIM * LUT_DIM +\r\n                     (g8 >> 2u) * LUT_DIM +\r\n                     (b8 >> 2u);\r\n\r\n        // Unpack L, a, b from the LUT entry.\r\n        let entry = lut[lutIdx];\r\n        let lF = f32(entry & 0xffu) / 255.0;\r\n        let aF = f32((entry >>  8u) & 0xffu) / 255.0 * (2.0 * AB_RANGE) - AB_RANGE;\r\n        let bF = f32((entry >> 16u) & 0xffu) / 255.0 * (2.0 * AB_RANGE) - AB_RANGE;\r\n\r\n        // Compare squared OKLab distance against the background.\r\n        let dL = lF - dims.bgL;\r\n        let dA = aF - dims.bgA;\r\n        let dB = bF - dims.bgB;\r\n\r\n        if (dL * dL + dA * dA + dB * dB > dims.threshSq) {\r\n            atomicOr(&wg_word, 1u << lid.x);\r\n        }\r\n    }\r\n\r\n    // \u2500\u2500 Step 3: thread 0 writes the accumulated word \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n    workgroupBarrier();\r\n    if (lii == 0u) {\r\n        output[wgid.y * dims.rowStride + wgid.x] = atomicLoad(&wg_word);\r\n    }\r\n}\r\n";

// src/gpu/content_mask.ts
var LUT_DIM = 64;
var LUT_SIZE = LUT_DIM * LUT_DIM * LUT_DIM;
var AB_RANGE = 0.4;
var cachedContentMask = null;
function getOrCreateContentMask(device) {
  if (cachedContentMask && cachedContentMask.device !== device) {
    cachedContentMask.lutBuffer.destroy();
    cachedContentMask = null;
  }
  if (cachedContentMask) return cachedContentMask;
  const lutData = new Uint32Array(LUT_SIZE);
  for (let r64 = 0; r64 < LUT_DIM; r64++) {
    for (let g64 = 0; g64 < LUT_DIM; g64++) {
      for (let b64 = 0; b64 < LUT_DIM; b64++) {
        const [L, a, b] = srgbToOklab(r64 * 4, g64 * 4, b64 * 4);
        const lU8 = Math.max(0, Math.min(255, Math.round(L * 255)));
        const aU8 = Math.max(0, Math.min(255, Math.round((a + AB_RANGE) / (2 * AB_RANGE) * 255)));
        const bU8 = Math.max(0, Math.min(255, Math.round((b + AB_RANGE) / (2 * AB_RANGE) * 255)));
        lutData[r64 * LUT_DIM * LUT_DIM + g64 * LUT_DIM + b64] = lU8 | aU8 << 8 | bU8 << 16;
      }
    }
  }
  const lutBuffer = device.createBuffer({
    size: LUT_SIZE * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint32Array(lutBuffer.getMappedRange()).set(lutData);
  lutBuffer.unmap();
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ]
  });
  const module = device.createShaderModule({ code: content_mask_default });
  const pipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    compute: { module, entryPoint: "main" }
  });
  cachedContentMask = { device, pipeline, bgl, lutBuffer };
  return cachedContentMask;
}
async function buildContentMaskGPU(device, image, bgOklab, threshold) {
  const { pipeline, bgl, lutBuffer } = getOrCreateContentMask(device);
  const rowStride = Math.ceil(image.width / 32);
  const maskWords = rowStride * image.height;
  const texture = device.createTexture({
    size: { width: image.width, height: image.height },
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  device.queue.writeTexture(
    { texture },
    image.data,
    { bytesPerRow: image.width * 4 },
    { width: image.width, height: image.height }
  );
  const uniformRaw = new ArrayBuffer(32);
  const u32View = new Uint32Array(uniformRaw);
  const f32View = new Float32Array(uniformRaw);
  u32View[0] = image.width;
  u32View[1] = image.height;
  u32View[2] = rowStride;
  u32View[3] = 0;
  f32View[4] = bgOklab[0];
  f32View[5] = bgOklab[1];
  f32View[6] = bgOklab[2];
  f32View[7] = threshold * threshold;
  const uniformBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true
  });
  new Uint8Array(uniformBuffer.getMappedRange()).set(new Uint8Array(uniformRaw));
  uniformBuffer.unmap();
  const maskBuffer = device.createBuffer({
    size: maskWords * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
  });
  const stagingBuffer = device.createBuffer({
    size: maskWords * 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });
  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: texture.createView() },
      { binding: 1, resource: { buffer: uniformBuffer } },
      { binding: 2, resource: { buffer: lutBuffer } },
      { binding: 3, resource: { buffer: maskBuffer } }
    ]
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(rowStride, image.height);
  pass.end();
  encoder.copyBufferToBuffer(maskBuffer, 0, stagingBuffer, 0, maskWords * 4);
  device.queue.submit([encoder.finish()]);
  await stagingBuffer.mapAsync(GPUMapMode.READ);
  const words = new Uint32Array(stagingBuffer.getMappedRange()).slice();
  stagingBuffer.unmap();
  texture.destroy();
  uniformBuffer.destroy();
  maskBuffer.destroy();
  stagingBuffer.destroy();
  return { words, width: image.width, height: image.height, rowStride };
}

// browser-app/ui/palette_ui.ts
var callbacks = null;
var currentPalette = null;
var modalOpen = false;
var selectedInputId = null;
var removedInputs = [];
var sidebarList = null;
var modalOverlay = null;
var modalBody = null;
var modalHint = null;
function fmtPct(fraction) {
  if (fraction <= 0) return "new";
  const pct = fraction * 100;
  if (pct >= 10) return `${pct.toFixed(1)}%`;
  if (pct >= 1) return `${pct.toFixed(2)}%`;
  if (pct >= 0.01) return `${pct.toFixed(3)}%`;
  return `${pct.toFixed(4)}%`;
}
function initPaletteEditor(cb) {
  callbacks = cb;
  sidebarList = document.getElementById("paletteList");
  modalOverlay = document.getElementById("paletteModal");
  if (modalOverlay) {
    modalBody = document.getElementById("modalBody");
    modalHint = document.getElementById("modalHint");
    modalOverlay.addEventListener("click", (e) => {
      if (e.target === modalOverlay) closeModal();
    });
    const closeBtn = document.getElementById("paletteModalClose");
    if (closeBtn) closeBtn.addEventListener("click", closeModal);
    const addOutBtn = document.getElementById("modalAddOutput");
    if (addOutBtn) {
      addOutBtn.addEventListener("click", () => pickColorThen("Pick a new output color", (rgb) => {
        if (!currentPalette) return;
        const [updated] = addOutput(currentPalette, rgb);
        emit(updated);
      }));
    }
    const addInBtn = document.getElementById("modalAddInput");
    if (addInBtn) {
      addInBtn.addEventListener("click", () => pickColorThen("Pick a new input color", (rgb) => {
        if (!currentPalette) return;
        const [updated] = addInput(currentPalette, rgb);
        emit(updated);
      }));
    }
  }
  const editBtn = document.getElementById("paletteEditBtn");
  if (editBtn) editBtn.addEventListener("click", openModal);
}
function renderPaletteEditor(palette) {
  currentPalette = palette;
  renderSidebar();
  if (modalOpen) renderModal();
}
function clearPaletteEditor() {
  currentPalette = null;
  selectedInputId = null;
  removedInputs = [];
  if (sidebarList) sidebarList.innerHTML = "";
  closeModal();
}
function emit(palette) {
  currentPalette = palette;
  if (callbacks) callbacks.onPaletteChanged(palette);
  renderPaletteEditor(palette);
}
function renderSidebar() {
  if (!sidebarList || !currentPalette) return;
  sidebarList.innerHTML = "";
  if (currentPalette.inputs.length === 0) {
    sidebarList.innerHTML = '<div class="palette-info">No colors found</div>';
    return;
  }
  for (const inp of currentPalette.inputs) {
    const row = document.createElement("div");
    row.className = "palette-row";
    if (!inp.enabled) row.classList.add("disabled");
    const swatch = document.createElement("div");
    swatch.className = "palette-input-swatch";
    swatch.style.background = rgbToHex(inp.rgb);
    row.appendChild(swatch);
    if (inp.role === "background") {
      const badge = document.createElement("span");
      badge.className = "palette-role-badge";
      badge.textContent = "BG";
      row.appendChild(badge);
    }
    if (isRemapped(currentPalette, inp.id)) {
      const out = currentPalette.outputs.find((o) => o.id === inp.outputId);
      if (out) {
        const arrow = document.createElement("span");
        arrow.className = "palette-arrow";
        arrow.textContent = "\u2192";
        row.appendChild(arrow);
        const outSwatch = document.createElement("div");
        outSwatch.className = "palette-output-swatch";
        outSwatch.style.background = rgbToHex(out.rgb);
        row.appendChild(outSwatch);
      }
    }
    const pct = document.createElement("span");
    pct.className = "palette-pct";
    pct.textContent = fmtPct(inp.fraction);
    row.appendChild(pct);
    sidebarList.appendChild(row);
  }
}
function openModal() {
  if (!modalOverlay || !currentPalette) return;
  modalOpen = true;
  selectedInputId = null;
  modalOverlay.classList.add("open");
  renderModal();
}
function closeModal() {
  modalOpen = false;
  selectedInputId = null;
  if (modalOverlay) modalOverlay.classList.remove("open");
}
function renderModal() {
  if (!modalBody || !currentPalette) return;
  if (modalHint) {
    modalHint.textContent = selectedInputId ? "Now click a bin header to move the selected input there." : "Click an input to select it, then click a different bin header to reassign.";
  }
  modalBody.innerHTML = "";
  const binMap = /* @__PURE__ */ new Map();
  for (const out of currentPalette.outputs) {
    binMap.set(out.id, []);
  }
  for (const inp of currentPalette.inputs) {
    const list = binMap.get(inp.outputId);
    if (list) list.push(inp);
  }
  for (const out of currentPalette.outputs) {
    const inputs = binMap.get(out.id) ?? [];
    const bin = createBin(out, inputs);
    modalBody.appendChild(bin);
  }
  if (removedInputs.length > 0) {
    const section = document.createElement("div");
    section.className = "palette-removed-section";
    const title = document.createElement("div");
    title.className = "palette-removed-title";
    title.textContent = "Removed";
    section.appendChild(title);
    for (let i = 0; i < removedInputs.length; i++) {
      const ri = removedInputs[i];
      const row = document.createElement("div");
      row.className = "palette-removed-row";
      const swatch = document.createElement("div");
      swatch.className = "modal-swatch-sm";
      swatch.style.background = rgbToHex(ri.rgb);
      row.appendChild(swatch);
      const label = document.createElement("span");
      label.className = "modal-color-label";
      label.textContent = rgbToHex(ri.rgb);
      row.appendChild(label);
      const pct = document.createElement("span");
      pct.className = "modal-pct";
      pct.textContent = fmtPct(ri.fraction);
      row.appendChild(pct);
      const addBtn = document.createElement("button");
      addBtn.className = "modal-small-btn";
      addBtn.textContent = "Re-add";
      addBtn.title = "Add back as input";
      const idx = i;
      addBtn.addEventListener("click", () => {
        if (!currentPalette) return;
        const [updated] = addInput(currentPalette, ri.rgb);
        removedInputs.splice(idx, 1);
        emit(updated);
      });
      row.appendChild(addBtn);
      section.appendChild(row);
    }
    modalBody.appendChild(section);
  }
}
function createBin(out, inputs) {
  const bin = document.createElement("div");
  bin.className = "palette-bin";
  if (out.isBackground) bin.classList.add("palette-bin-bg");
  const inputsCol = document.createElement("div");
  inputsCol.className = "bin-inputs";
  for (const inp of inputs) {
    const row = document.createElement("div");
    row.className = "bin-input-row";
    if (selectedInputId === inp.id) row.classList.add("selected");
    const inSwatch = document.createElement("div");
    inSwatch.className = "modal-swatch-sm";
    inSwatch.style.background = rgbToHex(inp.rgb);
    row.appendChild(inSwatch);
    const inLabel = document.createElement("span");
    inLabel.className = "modal-color-label";
    inLabel.textContent = rgbToHex(inp.rgb);
    row.appendChild(inLabel);
    const pct = document.createElement("span");
    pct.className = "modal-pct";
    pct.textContent = fmtPct(inp.fraction);
    row.appendChild(pct);
    if (currentPalette.inputs.length > 1) {
      const rmBtn = document.createElement("button");
      rmBtn.className = "modal-small-btn modal-small-btn-danger bin-hover-btn";
      rmBtn.textContent = "\xD7";
      rmBtn.title = "Remove input";
      rmBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!currentPalette) return;
        removedInputs.push({ rgb: [...inp.rgb], fraction: inp.fraction });
        emit(removeInput(currentPalette, inp.id));
      });
      row.appendChild(rmBtn);
    }
    row.addEventListener("click", () => {
      selectedInputId = selectedInputId === inp.id ? null : inp.id;
      renderModal();
    });
    inputsCol.appendChild(row);
  }
  bin.appendChild(inputsCol);
  const arrow = document.createElement("div");
  arrow.className = "bin-arrow";
  arrow.textContent = "\u2192";
  bin.appendChild(arrow);
  const outputCol = document.createElement("div");
  outputCol.className = "bin-output";
  if (selectedInputId) {
    outputCol.classList.add("bin-assignable");
  }
  outputCol.addEventListener("click", () => {
    if (selectedInputId && currentPalette) {
      emit(assignInput(currentPalette, selectedInputId, out.id));
      selectedInputId = null;
    }
  });
  const swatch = document.createElement("div");
  swatch.className = "modal-swatch modal-swatch-editable";
  swatch.style.background = rgbToHex(out.rgb);
  swatch.title = "Click to change output color";
  swatch.addEventListener("click", (e) => {
    e.stopPropagation();
    pickColorThen(`Change output color (${rgbToHex(out.rgb)})`, (rgb) => {
      if (!currentPalette) return;
      emit(setOutputColor(currentPalette, out.id, rgb));
    });
  });
  outputCol.appendChild(swatch);
  const label = document.createElement("span");
  label.className = "modal-color-label";
  label.textContent = rgbToHex(out.rgb);
  outputCol.appendChild(label);
  if (out.isBackground) {
    const badge = document.createElement("span");
    badge.className = "palette-role-badge";
    badge.textContent = "BG";
    outputCol.appendChild(badge);
  }
  const spacer = document.createElement("span");
  spacer.className = "bin-header-spacer";
  outputCol.appendChild(spacer);
  if (!out.isBackground) {
    const bgBtn = document.createElement("button");
    bgBtn.className = "modal-small-btn bin-hover-btn";
    bgBtn.textContent = "Set BG";
    bgBtn.title = "Set as background";
    bgBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!currentPalette) return;
      emit(setBackground(currentPalette, out.id));
    });
    outputCol.appendChild(bgBtn);
  }
  if (!out.isBackground && currentPalette.outputs.length > 1) {
    const delBtn = document.createElement("button");
    delBtn.className = "modal-small-btn modal-small-btn-danger bin-hover-btn";
    delBtn.textContent = "\xD7";
    delBtn.title = "Remove output bin";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!currentPalette) return;
      emit(removeOutput(currentPalette, out.id));
    });
    outputCol.appendChild(delBtn);
  }
  bin.appendChild(outputCol);
  return bin;
}
function pickColorThen(contextLabel, onPick) {
  if (modalOverlay) modalOverlay.classList.add("hidden-for-picker");
  const banner = document.createElement("div");
  banner.className = "picker-banner";
  banner.innerHTML = `
    <span class="picker-banner-label">${contextLabel}</span>
    <span class="picker-banner-hint">Choose a color from the picker, or use the eyedropper to sample from the page.</span>
    <button class="picker-banner-cancel">Cancel</button>
  `;
  document.body.appendChild(banner);
  const picker = document.createElement("input");
  picker.type = "color";
  picker.value = "#ff0000";
  picker.style.position = "absolute";
  picker.style.visibility = "hidden";
  document.body.appendChild(picker);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (modalOverlay) modalOverlay.classList.remove("hidden-for-picker");
    if (picker.parentNode) document.body.removeChild(picker);
    if (banner.parentNode) document.body.removeChild(banner);
  };
  picker.addEventListener("input", () => {
    const rgb = hexToRgb(picker.value);
    if (rgb) onPick(rgb);
  });
  picker.addEventListener("change", () => {
    const rgb = hexToRgb(picker.value);
    if (rgb) onPick(rgb);
    cleanup();
  });
  banner.querySelector(".picker-banner-cancel").addEventListener("click", () => {
    cleanup();
  });
  picker.addEventListener("blur", () => {
    setTimeout(cleanup, 300);
  });
  picker.click();
}
function rgbToHex(rgb) {
  const [r, g, b] = rgb;
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}
function hexToRgb(hex2) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex2);
  if (!m) return null;
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// browser-app/state.ts
var state = {
  currentScreen: "upload",
  currentFileId: null,
  pdfDoc: null,
  pdfFileName: "",
  pdfPageCount: 0,
  selectedPage: 0,
  rawImage: null,
  croppedRawImage: null,
  denoisedImage: null,
  cropRect: null,
  cropMode: true,
  viewerLayer: "raw",
  activeLayerIndex: -1,
  zoom: 1,
  panX: 0,
  panY: 0,
  onnxSession: null,
  isDenoising: false,
  denoiseProgress: 0,
  isPaletteExtracting: false,
  selectedPages: /* @__PURE__ */ new Set(),
  coverPage: 1,
  denoisedPages: /* @__PURE__ */ new Set(),
  pageLabels: [],
  pageSizes: [],
  pageLayout: null,
  activePageNumber: 0,
  cropRects: /* @__PURE__ */ new Map(),
  cropLocked: true,
  paletteEntries: null,
  bwCounts: null,
  editablePalette: null,
  paletteDecompositions: /* @__PURE__ */ new Map(),
  thinnedDecompositions: /* @__PURE__ */ new Map(),
  inkLayers: /* @__PURE__ */ new Map(),
  isThinning: false,
  isVectorizing: false,
  pathGraphs: /* @__PURE__ */ new Map(),
  simplifiedPathGraphs: /* @__PURE__ */ new Map(),
  undashedPathGraphs: /* @__PURE__ */ new Map(),
  strokeMarks: /* @__PURE__ */ new Map(),
  curveGraphs: /* @__PURE__ */ new Map(),
  curvePathGraphs: /* @__PURE__ */ new Map(),
  showFittedCurves: true,
  statusMessage: "Ready"
};

// src/formats/rgba_image.ts
function cropRGBAImage(image, cx, cy, cw, ch) {
  const data = new Uint8ClampedArray(cw * ch * 4);
  const srcW = image.width;
  const src = image.data;
  for (let y = 0; y < ch; y++) {
    const srcOff = ((cy + y) * srcW + cx) * 4;
    const dstOff = y * cw * 4;
    data.set(src.subarray(srcOff, srcOff + cw * 4), dstOff);
  }
  return { width: cw, height: ch, data };
}

// browser-app/storage.ts
var DB_NAME = "CleanPlansDB";
var DB_VERSION = 5;
var STORE_NAME = "files";
var CROP_STORE = "cropRects";
var PALETTE_STORE = "palettes";
var DENOISED_STORE = "denoisedImages";
var PAGE_SEL_STORE = "pageSelections";
var RENDER_CACHE_STORE = "renderCache";
var db = null;
function openDB() {
  if (db) return Promise.resolve(db);
  if (navigator.storage?.persist) {
    navigator.storage.persist().catch(() => {
    });
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      db = request.result;
      resolve(db);
    };
    request.onupgradeneeded = (event) => {
      const target = event.target.result;
      if (!target.objectStoreNames.contains(STORE_NAME)) {
        const store = target.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("uploadedAt", "uploadedAt", { unique: false });
      }
      if (!target.objectStoreNames.contains(CROP_STORE)) {
        target.createObjectStore(CROP_STORE, {
          keyPath: ["fileId", "pageNumber"]
        });
      }
      if (!target.objectStoreNames.contains(PALETTE_STORE)) {
        target.createObjectStore(PALETTE_STORE, { keyPath: "fileId" });
      }
      if (!target.objectStoreNames.contains(DENOISED_STORE)) {
        target.createObjectStore(DENOISED_STORE, {
          keyPath: ["fileId", "pageNumber"]
        });
      }
      if (!target.objectStoreNames.contains(PAGE_SEL_STORE)) {
        target.createObjectStore(PAGE_SEL_STORE, { keyPath: "fileId" });
      }
      if (!target.objectStoreNames.contains(RENDER_CACHE_STORE)) {
        target.createObjectStore(RENDER_CACHE_STORE, {
          keyPath: ["fileId", "pageNumber", "level"]
        });
      }
    };
  });
}
async function saveFile(file, thumbnail) {
  const database = await openDB();
  const id = crypto.randomUUID();
  const arrayBuffer = await file.arrayBuffer();
  const storedFile = {
    id,
    name: file.name,
    type: file.type,
    data: new Uint8Array(arrayBuffer),
    uploadedAt: Date.now(),
    thumbnail
  };
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.add(storedFile);
    request.onsuccess = () => resolve(id);
    request.onerror = () => reject(request.error);
  });
}
async function updateFile(id, updates) {
  const database = await openDB();
  const existing = await getFile(id);
  if (!existing) throw new Error(`File ${id} not found`);
  const updated = { ...existing, ...updates };
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(updated);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function getFile(id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
async function listFiles() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const files = request.result;
      files.sort((a, b) => b.uploadedAt - a.uploadedAt);
      resolve(files);
    };
    request.onerror = () => reject(request.error);
  });
}
async function deleteFile(id) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function clearAllFiles() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function saveCropRect(rect) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([CROP_STORE], "readwrite");
    const store = tx.objectStore(CROP_STORE);
    const request = store.put(rect);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function getCropRect(fileId, pageNumber) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([CROP_STORE], "readonly");
    const store = tx.objectStore(CROP_STORE);
    const request = store.get([fileId, pageNumber]);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
async function getCropRectsForFile(fileId) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([CROP_STORE], "readonly");
    const store = tx.objectStore(CROP_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const all = request.result;
      resolve(all.filter((r) => r.fileId === fileId));
    };
    request.onerror = () => reject(request.error);
  });
}
async function savePalette(fileId, palette) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([PALETTE_STORE], "readwrite");
    const store = tx.objectStore(PALETTE_STORE);
    const request = store.put({ fileId, palette });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function getPalette(fileId) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([PALETTE_STORE], "readonly");
    const store = tx.objectStore(PALETTE_STORE);
    const request = store.get(fileId);
    request.onsuccess = () => {
      const result = request.result;
      resolve(result?.palette ?? null);
    };
    request.onerror = () => reject(request.error);
  });
}
async function deletePalette(fileId) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([PALETTE_STORE], "readwrite");
    const store = tx.objectStore(PALETTE_STORE);
    const request = store.delete(fileId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function saveDenoisedImage(fileId, pageNumber, pngBlob, width, height) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([DENOISED_STORE], "readwrite");
    const store = tx.objectStore(DENOISED_STORE);
    const request = store.put({ fileId, pageNumber, pngBlob, width, height });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function getDenoisedImage(fileId, pageNumber) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([DENOISED_STORE], "readonly");
    const store = tx.objectStore(DENOISED_STORE);
    const request = store.get([fileId, pageNumber]);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
async function deleteDenoisedImage(fileId, pageNumber) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([DENOISED_STORE], "readwrite");
    const store = tx.objectStore(DENOISED_STORE);
    const request = store.delete([fileId, pageNumber]);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function getDenoisedPagesForFile(fileId) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([DENOISED_STORE], "readonly");
    const store = tx.objectStore(DENOISED_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const all = request.result;
      resolve(all.filter((r) => r.fileId === fileId).map((r) => r.pageNumber));
    };
    request.onerror = () => reject(request.error);
  });
}
async function savePageSelection(sel) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([PAGE_SEL_STORE], "readwrite");
    const store = tx.objectStore(PAGE_SEL_STORE);
    const request = store.put(sel);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function getPageSelection(fileId) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([PAGE_SEL_STORE], "readonly");
    const store = tx.objectStore(PAGE_SEL_STORE);
    const request = store.get(fileId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
function rgbaImageToPngBlob(image) {
  const canvas2 = new OffscreenCanvas(image.width, image.height);
  const ctx2 = canvas2.getContext("2d");
  ctx2.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0
  );
  return canvas2.convertToBlob({ type: "image/png" });
}
var DECODE_WORKER_CODE = `
self.onmessage = async (e) => {
  const { id, blob, width, height } = e.data;
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const imageData = ctx.getImageData(0, 0, width, height);
    self.postMessage(
      { id, width, height, data: imageData.data },
      [imageData.data.buffer],
    );
  } catch (err) {
    self.postMessage({ id, error: err.message || String(err) });
  }
};
`;
var decodeWorker = null;
var nextDecodeId = 0;
var decodePending = /* @__PURE__ */ new Map();
function getDecodeWorker() {
  if (!decodeWorker) {
    const src = new Blob([DECODE_WORKER_CODE], { type: "application/javascript" });
    decodeWorker = new Worker(URL.createObjectURL(src));
    decodeWorker.onmessage = (e) => {
      const { id, error, width, height, data } = e.data;
      const pending = decodePending.get(id);
      if (!pending) return;
      decodePending.delete(id);
      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve({ width, height, data });
      }
    };
  }
  return decodeWorker;
}
function pngBlobToRgbaImage(blob, width, height) {
  const id = nextDecodeId++;
  return new Promise((resolve, reject) => {
    decodePending.set(id, { resolve, reject });
    getDecodeWorker().postMessage({ id, blob, width, height });
  });
}
async function saveRenderCache(entry) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([RENDER_CACHE_STORE], "readwrite");
    const store = tx.objectStore(RENDER_CACHE_STORE);
    const request = store.put(entry);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
async function getRenderCache(fileId, pageNumber, level) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction([RENDER_CACHE_STORE], "readonly");
    const store = tx.objectStore(RENDER_CACHE_STORE);
    const request = store.get([fileId, pageNumber, level]);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

// browser-app/ui/upload.ts
var callbacks2;
function initUpload(cb) {
  callbacks2 = cb;
  const screen = document.getElementById("uploadScreen");
  const fileInput = document.getElementById("fileInput");
  const uploadBtn = document.getElementById("uploadBtn");
  const clearBtn = document.getElementById("clearAllBtn");
  uploadBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) handleFile(file);
    fileInput.value = "";
  });
  clearBtn.addEventListener("click", async () => {
    await clearAllFiles();
    await refreshFileList();
  });
  screen.addEventListener("dragover", (e) => {
    e.preventDefault();
    screen.classList.add("drag-over");
  });
  screen.addEventListener("dragleave", () => {
    screen.classList.remove("drag-over");
  });
  screen.addEventListener("drop", (e) => {
    e.preventDefault();
    screen.classList.remove("drag-over");
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  });
  refreshFileList();
}
function handleFile(file) {
  if (file.type !== "application/pdf") {
    state.statusMessage = "Please select a PDF file.";
    updateStatus();
    return;
  }
  callbacks2.onNewFile(file);
}
async function refreshFileList() {
  const container2 = document.getElementById("fileList");
  let files;
  try {
    files = await listFiles();
  } catch {
    container2.innerHTML = "";
    return;
  }
  if (files.length === 0) {
    container2.innerHTML = '<div class="file-list-empty">No saved files</div>';
    return;
  }
  container2.innerHTML = "";
  for (const f of files) {
    const row = document.createElement("div");
    row.className = "file-list-item";
    if (f.thumbnail) {
      const thumb = document.createElement("img");
      thumb.className = "file-list-thumb";
      thumb.src = f.thumbnail;
      thumb.alt = "";
      row.appendChild(thumb);
    }
    const nameEl = document.createElement("span");
    nameEl.className = "file-list-name";
    nameEl.textContent = f.name;
    nameEl.title = f.name;
    const dateEl = document.createElement("span");
    dateEl.className = "file-list-date";
    dateEl.textContent = formatDate(f.uploadedAt);
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "file-list-delete";
    deleteBtn.textContent = "\xD7";
    deleteBtn.title = "Remove";
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteFile(f.id);
      await refreshFileList();
    });
    row.appendChild(nameEl);
    row.appendChild(dateEl);
    row.appendChild(deleteBtn);
    row.addEventListener("click", () => {
      callbacks2.onStoredFileSelected(f);
    });
    container2.appendChild(row);
  }
}
function formatDate(timestamp) {
  const d = new Date(timestamp);
  const month = d.toLocaleString("default", { month: "short" });
  const day = d.getDate();
  const time = d.toLocaleTimeString("default", {
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${month} ${day}, ${time}`;
}
function updateStatus() {
  const el = document.getElementById("statusText");
  if (el) el.textContent = state.statusMessage;
}

// browser-app/ui/page_select.ts
var callbacks3 = null;
async function populatePageGrid(doc, pageCount, backend, selectedPages, denoisedPages, pageLabels) {
  const grid = document.getElementById("pageGrid");
  grid.innerHTML = "";
  const statusText = document.getElementById("pageStatusText");
  const pageSizes = await getPageSizes(doc);
  const maxArea = Math.max(...pageSizes.map((s) => s.widthPt * s.heightPt));
  const MIN_THUMB = 100;
  const MAX_THUMB = 240;
  const thumbContainers = [];
  for (let i = 1; i <= pageCount; i++) {
    const ps = pageSizes[i - 1];
    const area = ps.widthPt * ps.heightPt;
    const ratio = Math.sqrt(area / maxArea);
    const maxDim = Math.round(MIN_THUMB + ratio * (MAX_THUMB - MIN_THUMB));
    const aspect = ps.widthPt / ps.heightPt;
    let placeholderW, placeholderH;
    if (aspect >= 1) {
      placeholderW = maxDim;
      placeholderH = Math.round(maxDim / aspect);
    } else {
      placeholderH = maxDim;
      placeholderW = Math.round(maxDim * aspect);
    }
    const wrapper = document.createElement("div");
    wrapper.className = "page-thumb-wrapper";
    wrapper.dataset.page = String(i);
    if (selectedPages.has(i)) wrapper.classList.add("selected");
    if (denoisedPages.has(i)) wrapper.classList.add("denoised");
    const labelRow = document.createElement("div");
    labelRow.className = "page-label-row";
    const check = document.createElement("div");
    check.className = "page-check";
    check.textContent = "\u2713";
    const pageLabel = pageLabels?.[i - 1] ?? String(i);
    const label = document.createElement("span");
    label.className = "page-thumb-label";
    label.textContent = pageLabel;
    label.title = pageLabel;
    labelRow.appendChild(check);
    labelRow.appendChild(label);
    const thumbContainer = document.createElement("div");
    thumbContainer.className = "page-thumb-container";
    const placeholder = document.createElement("div");
    placeholder.className = "page-thumb-placeholder";
    placeholder.style.width = `${placeholderW}px`;
    placeholder.style.height = `${placeholderH}px`;
    const badge = document.createElement("div");
    badge.className = "page-denoised-badge";
    badge.textContent = "denoised";
    thumbContainer.appendChild(placeholder);
    thumbContainer.appendChild(badge);
    wrapper.appendChild(labelRow);
    wrapper.appendChild(thumbContainer);
    grid.appendChild(wrapper);
    thumbContainers.push(thumbContainer);
  }
  statusText.textContent = `${pageCount} page${pageCount !== 1 ? "s" : ""} \u2014 select pages, then Inspect Selected`;
  renderThumbnailsAsync(doc, pageCount, backend, pageSizes, maxArea, MIN_THUMB, MAX_THUMB, thumbContainers, pageLabels, statusText);
}
async function renderThumbnailsAsync(doc, pageCount, backend, pageSizes, maxArea, minThumb, maxThumb, thumbContainers, pageLabels, statusText) {
  for (let i = 1; i <= pageCount; i++) {
    const area = pageSizes[i - 1].widthPt * pageSizes[i - 1].heightPt;
    const ratio = Math.sqrt(area / maxArea);
    const maxDim = Math.round(minThumb + ratio * (maxThumb - minThumb));
    try {
      const thumb = await renderPdfThumbnail(doc, i, backend, maxDim);
      const canvas2 = document.createElement("canvas");
      canvas2.width = thumb.width;
      canvas2.height = thumb.height;
      canvas2.className = "page-thumb";
      canvas2.dataset.page = String(i);
      const pageLabel = pageLabels?.[i - 1] ?? String(i);
      canvas2.title = `Page ${pageLabel}`;
      const ctx2 = canvas2.getContext("2d");
      const imageData = new ImageData(thumb.data, thumb.width, thumb.height);
      ctx2.putImageData(imageData, 0, 0);
      const container2 = thumbContainers[i - 1];
      const placeholder = container2.querySelector(".page-thumb-placeholder");
      if (placeholder) {
        container2.replaceChild(canvas2, placeholder);
      }
    } catch (err) {
      console.error(`Failed to render thumbnail for page ${i}:`, err);
    }
    statusText.textContent = `Rendered ${i}/${pageCount} thumbnails`;
  }
}
function attachPageGridClickHandler(cb) {
  callbacks3 = cb;
  const grid = document.getElementById("pageGrid");
  grid.addEventListener("click", (e) => {
    const page = getPageFromEvent(e);
    if (page) callbacks3?.onPageToggled(page);
  });
}
function getPageFromEvent(e) {
  const target = e.target.closest(".page-thumb-wrapper");
  if (!target) return null;
  const page = Number(target.dataset.page);
  return page > 0 ? page : null;
}
function updatePageGridState(selectedPages, denoisedPages) {
  const grid = document.getElementById("pageGrid");
  if (!grid) return;
  const wrappers = grid.querySelectorAll(".page-thumb-wrapper");
  for (const w of wrappers) {
    const page = Number(w.dataset.page);
    w.classList.toggle("selected", selectedPages.has(page));
    w.classList.toggle("denoised", denoisedPages.has(page));
  }
  updateSelectionInfo(selectedPages.size, denoisedPages.size);
}
function updateSelectionInfo(selectedCount, denoisedCount) {
  const info = document.getElementById("pageSelectionInfo");
  if (info) {
    const parts = [];
    parts.push(`${selectedCount} page${selectedCount !== 1 ? "s" : ""} selected`);
    if (denoisedCount > 0) {
      parts.push(`${denoisedCount} denoised`);
    }
    info.textContent = parts.join(" \xB7 ");
  }
}

// wgsl-raw:C:\Users\gauch\code\vectorizor\cleanplans-web\src\gpu\shaders\multi_page_viewer.wgsl
var multi_page_viewer_default = "struct Uniforms {\r\n    // Canvas size in device pixels\r\n    canvas_size: vec2f,\r\n    _pad0: vec2f,\r\n    // Per-page quad: top-left in device pixels, size in device pixels\r\n    rect_origin: vec2f,\r\n    rect_size: vec2f,\r\n    // Texture dimensions (may differ from rect size for overview textures)\r\n    tex_size: vec2f,\r\n    // UV crop region: offset and scale within the texture\r\n    uv_offset: vec2f,\r\n    uv_scale: vec2f,\r\n    _pad1: vec2f,\r\n};\r\n\r\n@group(0) @binding(0) var<uniform> u: Uniforms;\r\n@group(0) @binding(1) var page_tex: texture_2d<f32>;\r\n@group(0) @binding(2) var page_samp: sampler;\r\n\r\nstruct VsOut {\r\n    @builtin(position) position: vec4f,\r\n    @location(0) uv: vec2f,\r\n};\r\n\r\n@vertex\r\nfn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {\r\n    // Quad: 2 triangles, 6 vertices\r\n    var corners = array<vec2f, 6>(\r\n        vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),\r\n        vec2f(0, 1), vec2f(1, 0), vec2f(1, 1),\r\n    );\r\n    let corner = corners[vi];\r\n\r\n    // Position in device pixels\r\n    let pos_px = u.rect_origin + corner * u.rect_size;\r\n\r\n    // Convert to NDC: x in [-1,1], y in [-1,1] (y-down in screen -> y-up in NDC)\r\n    let ndc = vec2f(\r\n        pos_px.x / u.canvas_size.x * 2.0 - 1.0,\r\n        -(pos_px.y / u.canvas_size.y * 2.0 - 1.0),\r\n    );\r\n\r\n    var out: VsOut;\r\n    out.position = vec4f(ndc, 0.0, 1.0);\r\n    out.uv = corner;\r\n    return out;\r\n}\r\n\r\n@fragment\r\nfn fs_main(in: VsOut) -> @location(0) vec4f {\r\n    // Map quad UV [0,1] to crop region within the texture\r\n    let uv = u.uv_offset + clamp(in.uv, vec2f(0.0), vec2f(1.0)) * u.uv_scale;\r\n    return textureSampleLevel(page_tex, page_samp, uv, 0.0);\r\n}\r\n";

// wgsl-raw:C:\Users\gauch\code\vectorizor\cleanplans-web\src\gpu\shaders\page_ink.wgsl
var page_ink_default = "// Draw a cleaned page straight from its palette bit-planes.\r\n//\r\n// A cleaned page is not a photograph: every pixel is either the background or\r\n// exactly one of a handful of ink colours, and the pipeline already holds that\r\n// on the GPU as one bit per ink per pixel.  Expanding it to an RGBA texture to\r\n// display it costs ~10x the memory of the thing it is displaying (a 30x20\"\r\n// sheet at 200 DPI: 9 MB of bit-planes vs 96 MB of RGBA) and needs a full\r\n// buffer readback to the CPU and back to get there.  So don't: bind the\r\n// bit-planes and resolve the colour in the fragment shader.\r\n//\r\n// Minification is the one thing the RGBA path gave us for free, via\r\n// pre-downsampled LOD textures.  Point-sampling 1-bit planes at 20% zoom drops\r\n// thin strokes entirely.  So this samples a box the size of the fragment's\r\n// footprint, `filter_steps` samples per axis, which is a fixed cost per\r\n// fragment and enough to keep a 1 px stroke visible as grey rather than gone.\r\n\r\nstruct Uniforms {\r\n    // Canvas size in device pixels.\r\n    canvas_size: vec2f,\r\n    // Per-page quad: top-left and size, in device pixels.\r\n    rect_origin: vec2f,\r\n    rect_size: vec2f,\r\n    // Bit-plane extent in pixels (the cropped region \u2014 exactly this quad).\r\n    ink_size: vec2f,\r\n    // u32 words per bit-plane row.\r\n    row_stride: u32,\r\n    // Number of ink layers in the buffer.\r\n    layer_count: u32,\r\n    // Ink to show, or -1 for all of them composited (the cleaned page).\r\n    active_layer: i32,\r\n    // Box-filter samples per axis; 1 = point sampling.\r\n    filter_steps: u32,\r\n};\r\n\r\nstruct Palette {\r\n    // Output colour per ink layer, .rgb used.\r\n    colors: array<vec4f, 8>,\r\n    // Page background.\r\n    background: vec4f,\r\n};\r\n\r\n@group(0) @binding(0) var<uniform> u: Uniforms;\r\n@group(0) @binding(1) var<storage, read> ink: array<u32>;\r\n@group(0) @binding(2) var<uniform> pal: Palette;\r\n\r\nstruct VsOut {\r\n    @builtin(position) position: vec4f,\r\n    @location(0) uv: vec2f,\r\n};\r\n\r\n@vertex\r\nfn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {\r\n    var corners = array<vec2f, 6>(\r\n        vec2f(0, 0), vec2f(1, 0), vec2f(0, 1),\r\n        vec2f(0, 1), vec2f(1, 0), vec2f(1, 1),\r\n    );\r\n    let corner = corners[vi];\r\n    let pos_px = u.rect_origin + corner * u.rect_size;\r\n    let ndc = vec2f(\r\n        pos_px.x / u.canvas_size.x * 2.0 - 1.0,\r\n        -(pos_px.y / u.canvas_size.y * 2.0 - 1.0),\r\n    );\r\n\r\n    var out: VsOut;\r\n    out.position = vec4f(ndc, 0.0, 1.0);\r\n    out.uv = corner;\r\n    return out;\r\n}\r\n\r\n/// Colour of one bit-plane pixel.  Layers are composited in buffer order, so\r\n/// the LAST ink set at a pixel wins \u2014 matching readAllLayersAsRGBA, which\r\n/// paints the layers over each other in the same order.\r\nfn ink_at(x: i32, y: i32) -> vec3f {\r\n    let word = u32(y) * u.row_stride + (u32(x) >> 5u);\r\n    let bit = 1u << (u32(x) & 31u);\r\n    let layer_words = u.row_stride * u32(u.ink_size.y);\r\n\r\n    if (u.active_layer >= 0) {\r\n        let li = u32(u.active_layer);\r\n        if ((ink[li * layer_words + word] & bit) != 0u) {\r\n            return pal.colors[li].rgb;\r\n        }\r\n        return pal.background.rgb;\r\n    }\r\n\r\n    for (var li = u.layer_count; li > 0u; li -= 1u) {\r\n        let idx = li - 1u;\r\n        if ((ink[idx * layer_words + word] & bit) != 0u) {\r\n            return pal.colors[idx].rgb;\r\n        }\r\n    }\r\n    return pal.background.rgb;\r\n}\r\n\r\n@fragment\r\nfn fs_main(in: VsOut) -> @location(0) vec4f {\r\n    let uv = clamp(in.uv, vec2f(0.0), vec2f(1.0));\r\n    let centre = uv * u.ink_size;\r\n\r\n    // Ink pixels covered by one device pixel.  At or above 1:1 this is <= 1 and\r\n    // the box collapses to a point sample.\r\n    let footprint = max(vec2f(1.0), u.ink_size / max(u.rect_size, vec2f(1.0)));\r\n\r\n    let steps = i32(max(u.filter_steps, 1u));\r\n    let w = i32(u.ink_size.x);\r\n    let h = i32(u.ink_size.y);\r\n\r\n    var acc = vec3f(0.0);\r\n    var n = 0.0;\r\n    for (var sy = 0; sy < steps; sy++) {\r\n        for (var sx = 0; sx < steps; sx++) {\r\n            let jitter = (vec2f(f32(sx), f32(sy)) + 0.5) / f32(steps) - 0.5;\r\n            let p = centre + jitter * footprint;\r\n            let x = i32(floor(p.x));\r\n            let y = i32(floor(p.y));\r\n            if (x < 0 || y < 0 || x >= w || y >= h) { continue; }\r\n            acc += ink_at(x, y);\r\n            n += 1.0;\r\n        }\r\n    }\r\n\r\n    if (n == 0.0) { return pal.background; }\r\n    return vec4f(acc / n, 1.0);\r\n}\r\n";

// src/gpu/multi_page_viewer.ts
function createMultiPageViewer(canvas2, gpu) {
  const { device } = gpu;
  const gpuCanvasCtx = canvas2.getContext("webgpu");
  if (!gpuCanvasCtx) throw new Error("Failed to get WebGPU canvas context");
  const navGpu = navigator.gpu;
  const format = navGpu.getPreferredCanvasFormat();
  gpuCanvasCtx.configure({ device, format, alphaMode: "opaque" });
  let _lastConfigW = 0;
  let _lastConfigH = 0;
  const shaderModule = device.createShaderModule({ code: multi_page_viewer_default });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } }
    ]
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shaderModule, entryPoint: "vs_main" },
    fragment: {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format }]
    },
    primitive: { topology: "triangle-list" }
  });
  const inkShaderModule = device.createShaderModule({ code: page_ink_default });
  const inkBindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }
    ]
  });
  const inkPipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [inkBindGroupLayout] }),
    vertex: { module: inkShaderModule, entryPoint: "vs_main" },
    fragment: { module: inkShaderModule, entryPoint: "fs_main", targets: [{ format }] },
    primitive: { topology: "triangle-list" }
  });
  const MAX_INK_LAYERS = 8;
  const inkPaletteBuffer = device.createBuffer({
    size: (MAX_INK_LAYERS + 1) * 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const inkPaletteScratch = new Float32Array((MAX_INK_LAYERS + 1) * 4);
  inkPaletteScratch[MAX_INK_LAYERS * 4 + 0] = 1;
  inkPaletteScratch[MAX_INK_LAYERS * 4 + 1] = 1;
  inkPaletteScratch[MAX_INK_LAYERS * 4 + 2] = 1;
  inkPaletteScratch[MAX_INK_LAYERS * 4 + 3] = 1;
  device.queue.writeBuffer(inkPaletteBuffer, 0, inkPaletteScratch);
  const inkUniformScratch = new ArrayBuffer(48);
  const inkUniformF32 = new Float32Array(inkUniformScratch);
  const inkUniformI32 = new Int32Array(inkUniformScratch);
  const inkUniformU32 = new Uint32Array(inkUniformScratch);
  const nearestSampler = device.createSampler({
    magFilter: "nearest",
    minFilter: "nearest"
  });
  const linearSampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear"
  });
  const pageTextures = /* @__PURE__ */ new Map();
  const scratchUniforms = new Float32Array(16);
  function createTextureFromImage(image) {
    const tex = device.createTexture({
      size: [image.width, image.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    device.queue.writeTexture(
      { texture: tex },
      image.data,
      { bytesPerRow: image.width * 4, rowsPerImage: image.height },
      [image.width, image.height]
    );
    return tex;
  }
  function createTextureFromBitmap(bitmap) {
    const tex = device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });
    device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: tex },
      [bitmap.width, bitmap.height]
    );
    return tex;
  }
  function createBindGroups(tex, ubuf) {
    const view = tex.createView();
    return {
      nearest: device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: ubuf } },
          { binding: 1, resource: view },
          { binding: 2, resource: nearestSampler }
        ]
      }),
      linear: device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: ubuf } },
          { binding: 1, resource: view },
          { binding: 2, resource: linearSampler }
        ]
      })
    };
  }
  function getOrCreateEntry(pageNumber) {
    let entry = pageTextures.get(pageNumber);
    if (!entry) {
      entry = {
        uniformBuffer: device.createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        }),
        thumbnailTexture: null,
        thumbnailBindGroupNearest: null,
        thumbnailBindGroupLinear: null,
        thumbnailScale: 1,
        overviewTexture: null,
        overviewBindGroupNearest: null,
        overviewBindGroupLinear: null,
        overviewScale: 1,
        fullTexture: null,
        fullBindGroupNearest: null,
        fullBindGroupLinear: null,
        ink: null,
        inkUniformBuffer: null,
        inkBindGroup: null
      };
      pageTextures.set(pageNumber, entry);
    }
    return entry;
  }
  function applyTextureToLevel(entry, tex, bgs, level, scale) {
    if (level === "thumbnail") {
      entry.thumbnailTexture?.destroy();
      entry.thumbnailTexture = tex;
      entry.thumbnailBindGroupNearest = bgs.nearest;
      entry.thumbnailBindGroupLinear = bgs.linear;
      entry.thumbnailScale = scale;
    } else if (level === "overview") {
      entry.overviewTexture?.destroy();
      entry.overviewTexture = tex;
      entry.overviewBindGroupNearest = bgs.nearest;
      entry.overviewBindGroupLinear = bgs.linear;
      entry.overviewScale = scale;
    } else {
      entry.fullTexture?.destroy();
      entry.fullTexture = tex;
      entry.fullBindGroupNearest = bgs.nearest;
      entry.fullBindGroupLinear = bgs.linear;
    }
  }
  function uploadTexture(pageNumber, image, level, overviewScale = 1) {
    const entry = getOrCreateEntry(pageNumber);
    const tex = createTextureFromImage(image);
    const bgs = createBindGroups(tex, entry.uniformBuffer);
    applyTextureToLevel(entry, tex, bgs, level, overviewScale);
  }
  function uploadBitmap(pageNumber, bitmap, level, overviewScale = 1) {
    const entry = getOrCreateEntry(pageNumber);
    const tex = createTextureFromBitmap(bitmap);
    const bgs = createBindGroups(tex, entry.uniformBuffer);
    applyTextureToLevel(entry, tex, bgs, level, overviewScale);
  }
  function evictTexture(pageNumber, level) {
    const entry = pageTextures.get(pageNumber);
    if (!entry) return;
    if (level === "full" && entry.fullTexture) {
      entry.fullTexture.destroy();
      entry.fullTexture = null;
      entry.fullBindGroupNearest = null;
      entry.fullBindGroupLinear = null;
    } else if (level === "overview" && entry.overviewTexture) {
      entry.overviewTexture.destroy();
      entry.overviewTexture = null;
      entry.overviewBindGroupNearest = null;
      entry.overviewBindGroupLinear = null;
    } else if (level === "thumbnail" && entry.thumbnailTexture) {
      entry.thumbnailTexture.destroy();
      entry.thumbnailTexture = null;
      entry.thumbnailBindGroupNearest = null;
      entry.thumbnailBindGroupLinear = null;
    }
  }
  function setInkSource(pageNumber, source) {
    const entry = getOrCreateEntry(pageNumber);
    entry.ink = source;
    if (!source) {
      entry.inkBindGroup = null;
      return;
    }
    if (!entry.inkUniformBuffer) {
      entry.inkUniformBuffer = device.createBuffer({
        size: 48,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
    }
    entry.inkBindGroup = device.createBindGroup({
      layout: inkBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: entry.inkUniformBuffer } },
        { binding: 1, resource: { buffer: source.buffer } },
        { binding: 2, resource: { buffer: inkPaletteBuffer } }
      ]
    });
  }
  function clearInkSources() {
    for (const entry of pageTextures.values()) {
      entry.ink = null;
      entry.inkBindGroup = null;
    }
  }
  function setInkPalette(colors, background) {
    inkPaletteScratch.fill(0);
    for (let i = 0; i < Math.min(colors.length, MAX_INK_LAYERS); i++) {
      const [r, g, b] = colors[i];
      inkPaletteScratch[i * 4 + 0] = r / 255;
      inkPaletteScratch[i * 4 + 1] = g / 255;
      inkPaletteScratch[i * 4 + 2] = b / 255;
      inkPaletteScratch[i * 4 + 3] = 1;
    }
    inkPaletteScratch[MAX_INK_LAYERS * 4 + 0] = background[0] / 255;
    inkPaletteScratch[MAX_INK_LAYERS * 4 + 1] = background[1] / 255;
    inkPaletteScratch[MAX_INK_LAYERS * 4 + 2] = background[2] / 255;
    inkPaletteScratch[MAX_INK_LAYERS * 4 + 3] = 1;
    device.queue.writeBuffer(inkPaletteBuffer, 0, inkPaletteScratch);
  }
  function hasFullTexture(pageNumber) {
    const entry = pageTextures.get(pageNumber);
    return !!entry?.fullTexture;
  }
  function render(layout, visibleRange, panX, panY, zoom, dpr) {
    const [firstIdx, lastIdx] = visibleRange;
    if (firstIdx < 0 || lastIdx < 0) return;
    const curW = canvas2.width;
    const curH = canvas2.height;
    if (curW === 0 || curH === 0) return;
    if (curW !== _lastConfigW || curH !== _lastConfigH) {
      gpuCanvasCtx.configure({ device, format, alphaMode: "opaque" });
      _lastConfigW = curW;
      _lastConfigH = curH;
    }
    const textureView = gpuCanvasCtx.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0.067, g: 0.067, b: 0.067, a: 1 }
        // #111
      }]
    });
    pass.setPipeline(pipeline);
    const canvasW = curW;
    const canvasH = curH;
    for (let i = firstIdx; i <= lastIdx; i++) {
      const page = layout.pages[i];
      const entry = pageTextures.get(page.pageNumber);
      if (!entry) continue;
      const pageLeft = (layout.maxWidth - page.width) / 2;
      const screenX = (pageLeft * zoom + panX) * dpr;
      const screenY = (page.yOffset * zoom + panY) * dpr;
      const screenW = page.width * zoom * dpr;
      const screenH = page.height * zoom * dpr;
      if (entry.ink && entry.inkBindGroup && entry.inkUniformBuffer) {
        const ink = entry.ink;
        const perPixel = screenW > 0 ? ink.width / screenW : 1;
        const steps = Math.max(1, Math.min(4, Math.ceil(perPixel)));
        inkUniformF32[0] = canvasW;
        inkUniformF32[1] = canvasH;
        inkUniformF32[2] = screenX;
        inkUniformF32[3] = screenY;
        inkUniformF32[4] = screenW;
        inkUniformF32[5] = screenH;
        inkUniformF32[6] = ink.width;
        inkUniformF32[7] = ink.height;
        inkUniformU32[8] = ink.rowStride;
        inkUniformU32[9] = ink.layerCount;
        inkUniformI32[10] = ink.activeLayer;
        inkUniformU32[11] = steps;
        device.queue.writeBuffer(entry.inkUniformBuffer, 0, inkUniformScratch);
        pass.setPipeline(inkPipeline);
        pass.setBindGroup(0, entry.inkBindGroup);
        pass.draw(6);
        pass.setPipeline(pipeline);
        continue;
      }
      let bindGroup;
      if (entry.fullTexture && entry.fullBindGroupNearest && entry.fullBindGroupLinear) {
        bindGroup = zoom >= 1 ? entry.fullBindGroupNearest : entry.fullBindGroupLinear;
      } else if (entry.overviewTexture && entry.overviewBindGroupNearest && entry.overviewBindGroupLinear) {
        const effectiveZoom = zoom * entry.overviewScale;
        bindGroup = effectiveZoom >= 1 ? entry.overviewBindGroupNearest : entry.overviewBindGroupLinear;
      } else if (entry.thumbnailTexture && entry.thumbnailBindGroupNearest && entry.thumbnailBindGroupLinear) {
        const effectiveZoom = zoom * entry.thumbnailScale;
        bindGroup = effectiveZoom >= 1 ? entry.thumbnailBindGroupNearest : entry.thumbnailBindGroupLinear;
      } else {
        continue;
      }
      const tex = entry.fullTexture ?? entry.overviewTexture ?? entry.thumbnailTexture;
      const texW = tex.width;
      const texH = tex.height;
      const uvOffX = page.srcX / page.fullWidth;
      const uvOffY = page.srcY / page.fullHeight;
      const uvScaleX = page.width / page.fullWidth;
      const uvScaleY = page.height / page.fullHeight;
      scratchUniforms[0] = canvasW;
      scratchUniforms[1] = canvasH;
      scratchUniforms[2] = 0;
      scratchUniforms[3] = 0;
      scratchUniforms[4] = screenX;
      scratchUniforms[5] = screenY;
      scratchUniforms[6] = screenW;
      scratchUniforms[7] = screenH;
      scratchUniforms[8] = texW;
      scratchUniforms[9] = texH;
      scratchUniforms[10] = uvOffX;
      scratchUniforms[11] = uvOffY;
      scratchUniforms[12] = uvScaleX;
      scratchUniforms[13] = uvScaleY;
      scratchUniforms[14] = 0;
      scratchUniforms[15] = 0;
      device.queue.writeBuffer(entry.uniformBuffer, 0, scratchUniforms);
      pass.setBindGroup(0, bindGroup);
      pass.draw(6);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  function destroy() {
    for (const entry of pageTextures.values()) {
      entry.thumbnailTexture?.destroy();
      entry.overviewTexture?.destroy();
      entry.fullTexture?.destroy();
      entry.uniformBuffer.destroy();
      entry.inkUniformBuffer?.destroy();
    }
    pageTextures.clear();
  }
  return {
    uploadTexture,
    uploadBitmap,
    evictTexture,
    setInkSource,
    clearInkSources,
    setInkPalette,
    hasFullTexture,
    render,
    destroy
  };
}

// wgsl-raw:C:\Users\gauch\code\vectorizor\cleanplans-web\src\gpu\shaders\graph_overlay.wgsl
var graph_overlay_default = '// Graph overlay shader.\r\n//\r\n// Two entry-point pairs for geometry (each also has a *_halo variant that\r\n// draws a slightly wider/larger white outline for contrast):\r\n//\r\n//   vs_edge / fs_edge             \u2014 path edge as a screen-space quad\r\n//   vs_edge_halo / fs_edge        \u2014 same quad, wider, white (drawn first)\r\n//\r\n//   vs_dot  / fs_dot              \u2014 vertex as a circle SDF quad\r\n//   vs_dot_halo / fs_dot          \u2014 same quad, larger, white (drawn first)\r\n//\r\n// Render order per frame: edge_halo \u2192 edge \u2192 dot_halo \u2192 dot\r\n// This ensures colored geometry always sits on top of its white outline.\r\n//\r\n// Coordinate system\r\n// \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\r\n// Graph vertex/edge coordinates are stored in virtual space (same coordinate\r\n// system as the MultiPageViewer).  The caller pre-transforms skeleton-pixel\r\n// coordinates to virtual space before upload(), so the shader only needs to\r\n// apply pan and zoom:\r\n//\r\n//   screen_device_px = (virtual_coord * zoom + pan_css) * dpr\r\n\r\n// ---------------------------------------------------------------------------\r\n// Uniforms (shared by all entry points)\r\n// ---------------------------------------------------------------------------\r\n\r\nstruct Uniforms {\r\n    canvas_w: f32,  // canvas width  (device pixels)\r\n    canvas_h: f32,  // canvas height (device pixels)\r\n    pan_x:    f32,  // pan in CSS pixels\r\n    pan_y:    f32,  // pan in CSS pixels\r\n    zoom:     f32,  // CSS px per virtual px\r\n    dpr:      f32,  // device pixel ratio\r\n    line_w:   f32,  // edge half-width in device pixels (fill pass)\r\n    dot_r:    f32,  // vertex dot radius in device pixels (fill pass)\r\n    halo_w:   f32,  // extra half-width added in the edge halo pass\r\n    halo_r:   f32,  // extra radius added in the dot halo pass\r\n    _pad0:    f32,\r\n    _pad1:    f32,\r\n}\r\n\r\n@group(0) @binding(0) var<uniform> u: Uniforms;\r\n\r\n// ---------------------------------------------------------------------------\r\n// Storage buffers\r\n// ---------------------------------------------------------------------------\r\n\r\n// Edge buffer: each edge is 8 \xD7 f32\r\n// [x1, y1, x2, y2, r, g, b, a]   (x/y in virtual space)\r\nstruct EdgeEntry {\r\n    x1: f32, y1: f32,\r\n    x2: f32, y2: f32,\r\n    r:  f32, g:  f32, b: f32, a: f32,\r\n}\r\n@group(0) @binding(1) var<storage, read> edges: array<EdgeEntry>;\r\n\r\n// Vertex (dot) buffer: each dot is 8 \xD7 f32\r\n// [x, y, r, g, b, a, size_scale, _pad]   (x/y in virtual space)\r\nstruct DotEntry {\r\n    x: f32, y: f32,\r\n    r: f32, g: f32, b: f32, a: f32,\r\n    size_scale: f32, _p1: f32,\r\n}\r\n@group(0) @binding(2) var<storage, read> dots: array<DotEntry>;\r\n\r\n// ---------------------------------------------------------------------------\r\n// Shared output structs\r\n// ---------------------------------------------------------------------------\r\n\r\nstruct EdgeVOut {\r\n    @builtin(position) position: vec4f,\r\n    @location(0)       color:    vec4f,\r\n}\r\n\r\nstruct DotVOut {\r\n    @builtin(position) position: vec4f,\r\n    @location(0)       color:    vec4f,\r\n    @location(1)       local_uv: vec2f, // [-1, +1] within the quad\r\n}\r\n\r\n// ---------------------------------------------------------------------------\r\n// White halo alpha (constant for both halo entry points)\r\n// ---------------------------------------------------------------------------\r\n\r\nconst HALO_ALPHA: f32 = 0.80;\r\n\r\n// ---------------------------------------------------------------------------\r\n// Helper: virtual-space coordinate \u2192 device pixel (screen space)\r\n// ---------------------------------------------------------------------------\r\n\r\nfn to_screen(vx: f32, vy: f32) -> vec2f {\r\n    return vec2f(\r\n        (vx * u.zoom + u.pan_x) * u.dpr,\r\n        (vy * u.zoom + u.pan_y) * u.dpr,\r\n    );\r\n}\r\n\r\nfn to_clip(sx: f32, sy: f32) -> vec2f {\r\n    return vec2f(\r\n        sx / u.canvas_w * 2.0 - 1.0,\r\n        1.0 - sy / u.canvas_h * 2.0,\r\n    );\r\n}\r\n\r\n// ---------------------------------------------------------------------------\r\n// Helper: build an EdgeVOut for a given half-width and color\r\n// ---------------------------------------------------------------------------\r\n\r\nfn make_edge_vout(vi: u32, ii: u32, hw: f32, color: vec4f) -> EdgeVOut {\r\n    let e = edges[ii];\r\n\r\n    let s1 = to_screen(e.x1, e.y1);\r\n    let s2 = to_screen(e.x2, e.y2);\r\n\r\n    let d   = s2 - s1;\r\n    let len = length(d);\r\n\r\n    // Degenerate edge (zero-length) \u2192 collapse to a point\r\n    var dir = vec2f(1.0, 0.0);\r\n    if (len > 0.001) { dir = d / len; }\r\n    let norm = vec2f(-dir.y, dir.x);\r\n\r\n    // Extend endpoints slightly to form neat caps\r\n    let p1 = s1 - dir * hw;\r\n    let p2 = s2 + dir * hw;\r\n\r\n    // Two triangles (6 vertices) forming a rectangle along the edge\r\n    let corners = array<vec2f, 6>(\r\n        p1 - norm * hw,\r\n        p1 + norm * hw,\r\n        p2 + norm * hw,\r\n        p1 - norm * hw,\r\n        p2 + norm * hw,\r\n        p2 - norm * hw,\r\n    );\r\n\r\n    let c = to_clip(corners[vi].x, corners[vi].y);\r\n    var out: EdgeVOut;\r\n    out.position = vec4f(c, 0.0, 1.0);\r\n    out.color    = color;\r\n    return out;\r\n}\r\n\r\n// ---------------------------------------------------------------------------\r\n// Helper: build a DotVOut for a given radius and color\r\n// ---------------------------------------------------------------------------\r\n\r\nfn make_dot_vout(vi: u32, ii: u32, r: f32, color: vec4f) -> DotVOut {\r\n    let d  = dots[ii];\r\n    let sc = to_screen(d.x, d.y);\r\n\r\n    // Screen-aligned quad corners and UV coordinates\r\n    let offsets = array<vec2f, 6>(\r\n        vec2f(-r, -r), vec2f(r, -r), vec2f(r,  r),\r\n        vec2f(-r, -r), vec2f(r,  r), vec2f(-r, r),\r\n    );\r\n    let uvs = array<vec2f, 6>(\r\n        vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0,  1.0),\r\n        vec2f(-1.0, -1.0), vec2f(1.0,  1.0), vec2f(-1.0, 1.0),\r\n    );\r\n\r\n    let pos = sc + offsets[vi];\r\n    let c   = to_clip(pos.x, pos.y);\r\n\r\n    var out: DotVOut;\r\n    out.position = vec4f(c, 0.0, 1.0);\r\n    out.color    = color;\r\n    out.local_uv = uvs[vi];\r\n    return out;\r\n}\r\n\r\n// ---------------------------------------------------------------------------\r\n// Edge entry points\r\n// ---------------------------------------------------------------------------\r\n\r\n@vertex fn vs_edge(\r\n    @builtin(vertex_index)   vi: u32,\r\n    @builtin(instance_index) ii: u32,\r\n) -> EdgeVOut {\r\n    let e = edges[ii];\r\n    return make_edge_vout(vi, ii, u.line_w, vec4f(e.r, e.g, e.b, e.a));\r\n}\r\n\r\n@vertex fn vs_edge_halo(\r\n    @builtin(vertex_index)   vi: u32,\r\n    @builtin(instance_index) ii: u32,\r\n) -> EdgeVOut {\r\n    return make_edge_vout(vi, ii, u.line_w + u.halo_w, vec4f(1.0, 1.0, 1.0, HALO_ALPHA));\r\n}\r\n\r\n@fragment fn fs_edge(in: EdgeVOut) -> @location(0) vec4f {\r\n    // Pre-multiply alpha for "premultiplied" canvas compositing\r\n    let a = in.color.a;\r\n    return vec4f(in.color.rgb * a, a);\r\n}\r\n\r\n// ---------------------------------------------------------------------------\r\n// Dot entry points\r\n// ---------------------------------------------------------------------------\r\n\r\n@vertex fn vs_dot(\r\n    @builtin(vertex_index)   vi: u32,\r\n    @builtin(instance_index) ii: u32,\r\n) -> DotVOut {\r\n    let d = dots[ii];\r\n    let r = u.dot_r * d.size_scale;\r\n    return make_dot_vout(vi, ii, r, vec4f(d.r, d.g, d.b, d.a));\r\n}\r\n\r\n@vertex fn vs_dot_halo(\r\n    @builtin(vertex_index)   vi: u32,\r\n    @builtin(instance_index) ii: u32,\r\n) -> DotVOut {\r\n    let d = dots[ii];\r\n    let r = u.dot_r * d.size_scale + u.halo_r;\r\n    return make_dot_vout(vi, ii, r, vec4f(1.0, 1.0, 1.0, HALO_ALPHA));\r\n}\r\n\r\n@fragment fn fs_dot(in: DotVOut) -> @location(0) vec4f {\r\n    // Discard fragments outside the unit circle (SDF)\r\n    if (dot(in.local_uv, in.local_uv) > 1.0) { discard; }\r\n    let a = in.color.a;\r\n    return vec4f(in.color.rgb * a, a);\r\n}\r\n';

// src/gpu/graph_overlay.ts
var EDGE_ALPHA = 0.85;
var DOT_ALPHA = 1;
var EDGE_HALF_WIDTH_CSS = 1;
var DOT_RADIUS_CSS = 3;
var DEFAULT_DOT_SCALE = 1;
var JUNCTION_DOT_SCALE = 1.3;
var HALO_EXTRA_HALF_W_CSS = 1.5;
var HALO_EXTRA_R_CSS = 1.5;
function layerRgb(layerIndex, layerColors) {
  if (layerIndex < layerColors.length) return layerColors[layerIndex];
  const FALLBACK = [
    [255, 80, 80],
    [80, 180, 80],
    [80, 80, 255],
    [255, 200, 0],
    [255, 80, 200],
    [80, 220, 220],
    [200, 160, 80],
    [160, 80, 200],
    [255, 140, 40],
    [0, 200, 160],
    [160, 200, 0],
    [40, 120, 255],
    [220, 80, 120],
    [80, 160, 200],
    [200, 80, 80],
    [80, 200, 120]
  ];
  return FALLBACK[layerIndex % FALLBACK.length];
}
function boostColor(r, g, b) {
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luma < 64) {
    return [Math.max(r, 180), Math.max(g, 100), Math.max(b, 180)];
  }
  return [r, g, b];
}
function flattenGraphs(pages, activeLayer) {
  let maxEdges = 0;
  let maxDots = 0;
  for (const { graph } of pages) {
    maxEdges += graph.edges.length + 4;
    maxDots += graph.vertices.length;
  }
  const edgeData = new Float32Array(maxEdges * 8);
  const dotData = new Float32Array(maxDots * 8);
  let ei = 0;
  let di = 0;
  for (const { graph, imgOriginX, imgOriginY, layerColors } of pages) {
    const { vertices, edges } = graph;
    for (const edge of edges) {
      if (activeLayer >= 0 && edge.layer !== activeLayer) continue;
      const fromV = vertices[edge.from];
      const toV = vertices[edge.to];
      if (!fromV || !toV) continue;
      const [lr, lg, lb] = layerRgb(edge.layer, layerColors);
      const [r, g, b] = boostColor(lr, lg, lb);
      const x1 = imgOriginX + fromV.x + 0.5;
      const y1 = imgOriginY + fromV.y + 0.5;
      const x2 = imgOriginX + toV.x + 0.5;
      const y2 = imgOriginY + toV.y + 0.5;
      const base = ei * 8;
      edgeData[base + 0] = x1;
      edgeData[base + 1] = y1;
      edgeData[base + 2] = x2;
      edgeData[base + 3] = y2;
      edgeData[base + 4] = r / 255;
      edgeData[base + 5] = g / 255;
      edgeData[base + 6] = b / 255;
      edgeData[base + 7] = EDGE_ALPHA;
      ei++;
    }
    for (const vtx of vertices) {
      if (vtx.type === "chain") continue;
      if (activeLayer >= 0 && vtx.layer !== activeLayer) continue;
      const [lr, lg, lb] = layerRgb(vtx.layer, layerColors);
      let [r, g, b] = boostColor(lr, lg, lb);
      let sizeScale = DEFAULT_DOT_SCALE;
      switch (vtx.type) {
        case "junction":
          r = 255;
          g = 255;
          b = 255;
          sizeScale = JUNCTION_DOT_SCALE;
          break;
        case "isolated":
          r = 255;
          g = 160;
          b = 0;
          sizeScale = DEFAULT_DOT_SCALE;
          break;
        default:
          break;
      }
      const base = di * 8;
      dotData[base + 0] = imgOriginX + vtx.x + 0.5;
      dotData[base + 1] = imgOriginY + vtx.y + 0.5;
      dotData[base + 2] = r / 255;
      dotData[base + 3] = g / 255;
      dotData[base + 4] = b / 255;
      dotData[base + 5] = DOT_ALPHA;
      dotData[base + 6] = sizeScale;
      dotData[base + 7] = 0;
      di++;
    }
  }
  return {
    edgeData: edgeData.subarray(0, ei * 8),
    dotData: dotData.subarray(0, di * 8),
    edgeCount: ei,
    dotCount: di
  };
}
var cachedPipelines = null;
function getOrCreatePipelines(device, format) {
  if (cachedPipelines && cachedPipelines.device === device) return cachedPipelines;
  const bgl = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" }
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" }
      },
      {
        binding: 2,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "read-only-storage" }
      }
    ]
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const module = device.createShaderModule({ code: graph_overlay_default });
  const blendState = {
    color: {
      operation: "add",
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha"
    },
    alpha: {
      operation: "add",
      srcFactor: "one",
      dstFactor: "one-minus-src-alpha"
    }
  };
  const edgeHaloPipeline = device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: "vs_edge_halo" },
    fragment: { module, entryPoint: "fs_edge", targets: [{ format, blend: blendState }] },
    primitive: { topology: "triangle-list" }
  });
  const edgeFillPipeline = device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: "vs_edge" },
    fragment: { module, entryPoint: "fs_edge", targets: [{ format, blend: blendState }] },
    primitive: { topology: "triangle-list" }
  });
  const dotHaloPipeline = device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: "vs_dot_halo" },
    fragment: { module, entryPoint: "fs_dot", targets: [{ format, blend: blendState }] },
    primitive: { topology: "triangle-list" }
  });
  const dotFillPipeline = device.createRenderPipeline({
    layout,
    vertex: { module, entryPoint: "vs_dot" },
    fragment: { module, entryPoint: "fs_dot", targets: [{ format, blend: blendState }] },
    primitive: { topology: "triangle-list" }
  });
  const uniformBuf = device.createBuffer({
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
  });
  const dummyEdgeBuf = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  const dummyDotBuf = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  });
  cachedPipelines = {
    device,
    bgl,
    edgeHaloPipeline,
    edgeFillPipeline,
    dotHaloPipeline,
    dotFillPipeline,
    uniformBuf,
    dummyEdgeBuf,
    dummyDotBuf
  };
  return cachedPipelines;
}
function createGraphOverlay(canvas2, gpu) {
  const { device } = gpu;
  const gpuCtx = canvas2.getContext("webgpu");
  if (!gpuCtx) throw new Error("Failed to get WebGPU context on overlay canvas");
  const navGpu = navigator.gpu;
  const format = navGpu.getPreferredCanvasFormat();
  gpuCtx.configure({ device, format, alphaMode: "premultiplied" });
  let _lastConfigW = 0;
  let _lastConfigH = 0;
  const pipelineState = getOrCreatePipelines(device, format);
  const { bgl, edgeHaloPipeline, edgeFillPipeline, dotHaloPipeline, dotFillPipeline, uniformBuf } = pipelineState;
  let edgeBuf = null;
  let dotBuf = null;
  let edgeCount = 0;
  let dotCount = 0;
  let bindGroup = null;
  let visible = true;
  function uploadBuffer(data, oldBuf) {
    oldBuf?.destroy();
    const byteLen = Math.max(data.byteLength, 32);
    const buf = device.createBuffer({
      size: byteLen,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength);
    return buf;
  }
  function rebuildBindGroup() {
    const eb = edgeBuf ?? pipelineState.dummyEdgeBuf;
    const db2 = dotBuf ?? pipelineState.dummyDotBuf;
    bindGroup = device.createBindGroup({
      layout: bgl,
      entries: [
        { binding: 0, resource: { buffer: uniformBuf } },
        { binding: 1, resource: { buffer: eb } },
        { binding: 2, resource: { buffer: db2 } }
      ]
    });
  }
  function upload(pages, activeLayer) {
    if (pages.length === 0) {
      edgeBuf?.destroy();
      edgeBuf = null;
      edgeCount = 0;
      dotBuf?.destroy();
      dotBuf = null;
      dotCount = 0;
      rebuildBindGroup();
      return;
    }
    const flat = flattenGraphs(pages, activeLayer);
    edgeCount = flat.edgeCount;
    dotCount = flat.dotCount;
    edgeBuf = uploadBuffer(flat.edgeData, edgeBuf);
    dotBuf = uploadBuffer(flat.dotData, dotBuf);
    rebuildBindGroup();
  }
  function render(panX, panY, zoom, dpr) {
    if (!visible) return;
    const hasGraph = (edgeCount > 0 || dotCount > 0) && bindGroup !== null;
    if (!hasGraph) return;
    const cw = canvas2.width;
    const ch = canvas2.height;
    if (cw === 0 || ch === 0) return;
    if (cw !== _lastConfigW || ch !== _lastConfigH) {
      gpuCtx.configure({ device, format, alphaMode: "premultiplied" });
      _lastConfigW = cw;
      _lastConfigH = ch;
    }
    const uniforms = new Float32Array([
      cw,
      ch,
      panX,
      panY,
      zoom,
      dpr,
      EDGE_HALF_WIDTH_CSS * dpr,
      DOT_RADIUS_CSS * dpr,
      HALO_EXTRA_HALF_W_CSS * dpr,
      HALO_EXTRA_R_CSS * dpr,
      0,
      0
    ]);
    device.queue.writeBuffer(uniformBuf, 0, uniforms);
    const textureView = gpuCtx.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0, g: 0, b: 0, a: 0 }
        // fully transparent
      }]
    });
    if (hasGraph) {
      pass.setBindGroup(0, bindGroup);
      if (edgeCount > 0) {
        pass.setPipeline(edgeHaloPipeline);
        pass.draw(6, edgeCount);
        pass.setPipeline(edgeFillPipeline);
        pass.draw(6, edgeCount);
      }
      if (dotCount > 0) {
        pass.setPipeline(dotHaloPipeline);
        pass.draw(6, dotCount);
        pass.setPipeline(dotFillPipeline);
        pass.draw(6, dotCount);
      }
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }
  function setVisible(v) {
    visible = v;
    canvas2.style.display = v ? "" : "none";
  }
  function destroy() {
    edgeBuf?.destroy();
    dotBuf?.destroy();
  }
  return { upload, render, setVisible, destroy };
}

// browser-app/ui/texture_manager.ts
var THUMBNAIL_DPI = 50;
var OVERVIEW_DPI = 100;
var MAX_THUMBNAILS = 50;
var OVERVIEW_THRESHOLD = 0.12;
var FULL_TEXTURE_THRESHOLD = 1.5;
function dimsMatch(a, b) {
  return Math.abs(a - b) <= 2;
}
function downsample(src, dstW, dstH) {
  const dst = new Uint8ClampedArray(dstW * dstH * 4);
  const sx = src.width / dstW;
  const sy = src.height / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const x0 = Math.floor(dx * sx);
      const y0 = Math.floor(dy * sy);
      const x1 = Math.min(Math.floor((dx + 1) * sx), src.width);
      const y1 = Math.min(Math.floor((dy + 1) * sy), src.height);
      const count = (x1 - x0) * (y1 - y0);
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * src.width + x) * 4;
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          a += src.data[i + 3];
        }
      }
      const di = (dy * dstW + dx) * 4;
      dst[di] = r / count;
      dst[di + 1] = g / count;
      dst[di + 2] = b / count;
      dst[di + 3] = a / count;
    }
  }
  return { width: dstW, height: dstH, data: dst };
}
var BLOB_CACHE_MAX = 20;
function createTextureManager(viewer, callbacks4, doc, backend, fileId) {
  const thumbnailScales = /* @__PURE__ */ new Map();
  const overviewScales = /* @__PURE__ */ new Map();
  const loadingThumbnail = /* @__PURE__ */ new Set();
  const hasThumbnailLoaded = /* @__PURE__ */ new Set();
  const loadingOverview = /* @__PURE__ */ new Set();
  const hasOverviewLoaded = /* @__PURE__ */ new Set();
  const loadingFull = /* @__PURE__ */ new Set();
  const hasFullLoaded = /* @__PURE__ */ new Set();
  const pageDims = /* @__PURE__ */ new Map();
  const fullFailed = /* @__PURE__ */ new Map();
  const thumbnailGen = /* @__PURE__ */ new Map();
  const overviewGen = /* @__PURE__ */ new Map();
  const fullGen = /* @__PURE__ */ new Map();
  let viewMode = "denoised";
  let suspended = false;
  const denoisedPageSet = /* @__PURE__ */ new Set();
  let reportDenoisedFailed;
  function denoisedOnly(pageNumber) {
    return viewMode === "denoised" && denoisedPageSet.has(pageNumber);
  }
  let viewGeneration = 0;
  const blobCache = /* @__PURE__ */ new Map();
  const blobCacheOrder = [];
  function blobCachePut(pageNumber, entry, kind) {
    const idx = blobCacheOrder.indexOf(pageNumber);
    if (idx >= 0) blobCacheOrder.splice(idx, 1);
    blobCacheOrder.push(pageNumber);
    blobCache.set(pageNumber, { ...entry, kind });
    while (blobCacheOrder.length > BLOB_CACHE_MAX) {
      const evicted = blobCacheOrder.shift();
      blobCache.delete(evicted);
    }
  }
  function stale(gen, loaded, page) {
    return !loaded.has(page) || gen.get(page) !== viewGeneration;
  }
  function invalidateView() {
    viewGeneration++;
    if (suspended) return;
    loadingThumbnail.clear();
    loadingOverview.clear();
    loadingFull.clear();
    for (const pageNum of [...hasFullLoaded]) {
      loadFull(pageNum).catch((err) => console.error(`view switch: full reload failed for page ${pageNum}:`, err));
    }
    for (const pageNum of [...hasOverviewLoaded]) {
      loadOverviewTexture(pageNum).catch((err) => console.error(`view switch: overview reload failed for page ${pageNum}:`, err));
    }
  }
  function blobCacheGet(pageNumber, kind) {
    const entry = blobCache.get(pageNumber);
    if (entry && entry.kind !== kind) return void 0;
    if (entry) {
      const idx = blobCacheOrder.indexOf(pageNumber);
      if (idx >= 0) blobCacheOrder.splice(idx, 1);
      blobCacheOrder.push(pageNumber);
    }
    return entry;
  }
  async function denoisedFullBlob(pageNumber) {
    const cached = blobCacheGet(pageNumber, "denoised");
    if (cached) return cached;
    try {
      const stored = await getDenoisedImage(fileId, pageNumber);
      if (!stored) return void 0;
      const entry = { blob: stored.pngBlob, width: stored.width, height: stored.height };
      blobCachePut(pageNumber, entry, "denoised");
      return entry;
    } catch {
      return void 0;
    }
  }
  async function loadThumbnail(page) {
    const pageNum = page.pageNumber;
    const thumbnailScale = THUMBNAIL_DPI / 200;
    const gen = viewGeneration;
    const accept = (upload) => {
      if (gen !== viewGeneration) return true;
      upload();
      thumbnailScales.set(pageNum, thumbnailScale);
      hasThumbnailLoaded.add(pageNum);
      thumbnailGen.set(pageNum, gen);
      return true;
    };
    const levels = denoisedOnly(pageNum) ? ["denoisedThumbnail"] : viewMode === "raw" ? ["thumbnail"] : ["denoisedThumbnail", "thumbnail"];
    for (const level of levels) {
      try {
        const cached = await getRenderCache(fileId, pageNum, level);
        if (gen !== viewGeneration) return;
        if (cached) {
          const bitmap = await createImageBitmap(cached.pngBlob);
          if (gen !== viewGeneration) {
            bitmap.close();
            return;
          }
          accept(() => viewer.uploadBitmap(pageNum, bitmap, "thumbnail", thumbnailScale));
          bitmap.close();
          return;
        }
      } catch {
      }
    }
    if (denoisedOnly(pageNum)) {
      const full = await denoisedFullBlob(pageNum);
      if (gen !== viewGeneration) return;
      if (full) {
        const tw = Math.max(1, Math.round(full.width * thumbnailScale));
        const th = Math.max(1, Math.round(full.height * thumbnailScale));
        const bitmap = await createImageBitmap(full.blob, {
          resizeWidth: tw,
          resizeHeight: th,
          resizeQuality: "high"
        });
        if (gen !== viewGeneration) {
          bitmap.close();
          return;
        }
        accept(() => viewer.uploadBitmap(pageNum, bitmap, "thumbnail", thumbnailScale));
        bitmap.close();
        return;
      }
      console.warn(`page ${pageNum} is marked denoised but has no denoised image; showing the raw scan and clearing the flag`);
      denoisedPageSet.delete(pageNum);
      reportDenoisedFailed?.(pageNum);
      const raw = await getRenderCache(fileId, pageNum, "thumbnail").catch(() => null);
      if (gen !== viewGeneration) return;
      if (raw) {
        const bitmap = await createImageBitmap(raw.pngBlob);
        if (gen !== viewGeneration) {
          bitmap.close();
          return;
        }
        accept(() => viewer.uploadBitmap(pageNum, bitmap, "thumbnail", thumbnailScale));
        bitmap.close();
        return;
      }
    }
    const scale = THUMBNAIL_DPI / 72;
    const rendered = await renderPdfPage(doc, pageNum, backend, scale);
    if (gen !== viewGeneration) return;
    const image = {
      width: rendered.width,
      height: rendered.height,
      data: rendered.data
    };
    accept(() => viewer.uploadTexture(pageNum, image, "thumbnail", thumbnailScale));
    rgbaImageToPngBlob(image).then((blob) => {
      saveRenderCache({
        fileId,
        pageNumber: pageNum,
        level: "thumbnail",
        pngBlob: blob,
        width: image.width,
        height: image.height
      }).catch(() => {
      });
    }).catch(() => {
    });
  }
  async function loadDenoisedThumbnail(page) {
    try {
      const cached = await getRenderCache(fileId, page.pageNumber, "denoisedThumbnail");
      if (!cached) return false;
      const thumbnailScale = THUMBNAIL_DPI / 200;
      const bitmap = await createImageBitmap(cached.pngBlob);
      viewer.uploadBitmap(page.pageNumber, bitmap, "thumbnail", thumbnailScale);
      bitmap.close();
      thumbnailScales.set(page.pageNumber, thumbnailScale);
      hasThumbnailLoaded.add(page.pageNumber);
      thumbnailGen.set(page.pageNumber, viewGeneration);
      return true;
    } catch {
      return false;
    }
  }
  async function loadOverviewTexture(pageNumber) {
    if (loadingOverview.has(pageNumber)) return;
    if (!stale(overviewGen, hasOverviewLoaded, pageNumber)) return;
    loadingOverview.add(pageNumber);
    const gen = viewGeneration;
    const overviewScale = OVERVIEW_DPI / 200;
    try {
      const levels = denoisedOnly(pageNumber) ? ["denoisedOverview"] : viewMode === "raw" ? ["overview"] : ["denoisedOverview", "overview"];
      for (const level of levels) {
        try {
          const cached = await getRenderCache(fileId, pageNumber, level);
          if (gen !== viewGeneration) return;
          if (cached) {
            const bitmap = await createImageBitmap(cached.pngBlob);
            if (gen !== viewGeneration) {
              bitmap.close();
              return;
            }
            viewer.uploadBitmap(pageNumber, bitmap, "overview", overviewScale);
            bitmap.close();
            overviewScales.set(pageNumber, overviewScale);
            hasOverviewLoaded.add(pageNumber);
            overviewGen.set(pageNumber, gen);
            callbacks4.onTextureReady(pageNumber, "overview");
            return;
          }
        } catch {
        }
      }
      if (denoisedOnly(pageNumber)) {
        const full = await denoisedFullBlob(pageNumber);
        if (gen !== viewGeneration) return;
        if (full) {
          const ow = Math.max(1, Math.round(full.width * overviewScale));
          const oh = Math.max(1, Math.round(full.height * overviewScale));
          const bitmap = await createImageBitmap(full.blob, {
            resizeWidth: ow,
            resizeHeight: oh,
            resizeQuality: "high"
          });
          if (gen !== viewGeneration) {
            bitmap.close();
            return;
          }
          viewer.uploadBitmap(pageNumber, bitmap, "overview", overviewScale);
          bitmap.close();
          overviewScales.set(pageNumber, overviewScale);
          hasOverviewLoaded.add(pageNumber);
          overviewGen.set(pageNumber, gen);
          callbacks4.onTextureReady(pageNumber, "overview");
          return;
        }
        console.warn(`page ${pageNumber} is marked denoised but has no denoised image; showing the raw scan and clearing the flag`);
        denoisedPageSet.delete(pageNumber);
        reportDenoisedFailed?.(pageNumber);
      }
      const scale = OVERVIEW_DPI / 72;
      const rendered = await renderPdfPage(doc, pageNumber, backend, scale);
      if (gen !== viewGeneration) return;
      const image = {
        width: rendered.width,
        height: rendered.height,
        data: rendered.data
      };
      viewer.uploadTexture(pageNumber, image, "overview", overviewScale);
      overviewScales.set(pageNumber, overviewScale);
      hasOverviewLoaded.add(pageNumber);
      overviewGen.set(pageNumber, gen);
      rgbaImageToPngBlob(image).then((blob) => {
        saveRenderCache({
          fileId,
          pageNumber,
          level: "overview",
          pngBlob: blob,
          width: image.width,
          height: image.height
        }).catch(() => {
        });
      }).catch(() => {
      });
      callbacks4.onTextureReady(pageNumber, "overview");
    } finally {
      loadingOverview.delete(pageNumber);
    }
  }
  async function loadFull(pageNumber) {
    if (loadingFull.has(pageNumber)) return;
    if (fullFailed.get(pageNumber) === viewGeneration) return;
    if (!stale(fullGen, hasFullLoaded, pageNumber)) return;
    loadingFull.add(pageNumber);
    const gen = viewGeneration;
    const dims = pageDims.get(pageNumber);
    try {
      let blobEntry;
      const wantDenoised = viewMode === "denoised";
      blobEntry = blobCacheGet(pageNumber, wantDenoised ? "denoised" : "raw");
      if (!blobEntry && wantDenoised) {
        try {
          const stored = await getDenoisedImage(fileId, pageNumber);
          if (gen !== viewGeneration) return;
          if (stored) {
            const isFullPage = !dims || dimsMatch(stored.width, dims.width) && dimsMatch(stored.height, dims.height);
            if (isFullPage) {
              blobEntry = { blob: stored.pngBlob, width: stored.width, height: stored.height };
            } else {
              console.warn(`Deleting stale denoised image for page ${pageNumber}: ${stored.width}\xD7${stored.height} vs expected ${dims.width}\xD7${dims.height}`);
              await deleteDenoisedImage(fileId, pageNumber);
              denoisedPageSet.delete(pageNumber);
              reportDenoisedFailed?.(pageNumber);
            }
          }
        } catch {
        }
      }
      if (!blobEntry && denoisedOnly(pageNumber)) {
        console.warn(`page ${pageNumber} is marked denoised but has no denoised image; showing the raw scan and clearing the flag`);
        denoisedPageSet.delete(pageNumber);
        reportDenoisedFailed?.(pageNumber);
      }
      if (!blobEntry) {
        try {
          const cached = await getRenderCache(fileId, pageNumber, "full");
          if (gen !== viewGeneration) return;
          if (cached) {
            blobEntry = { blob: cached.pngBlob, width: cached.width, height: cached.height };
          }
        } catch {
        }
      }
      if (gen !== viewGeneration) return;
      if (blobEntry) {
        blobCachePut(pageNumber, blobEntry, wantDenoised ? "denoised" : "raw");
        const bitmap = await createImageBitmap(blobEntry.blob);
        if (gen !== viewGeneration) {
          bitmap.close();
          return;
        }
        try {
          viewer.uploadBitmap(pageNumber, bitmap, "full");
        } catch (err) {
          console.warn(`bitmap upload failed for page ${pageNumber}; decoding to RGBA instead:`, err);
          viewer.uploadTexture(
            pageNumber,
            await pngBlobToRgbaImage(blobEntry.blob, blobEntry.width, blobEntry.height),
            "full"
          );
        } finally {
          bitmap.close();
        }
      } else {
        const rendered = await renderPdfPage(doc, pageNumber, backend, SCALE_200DPI);
        if (gen !== viewGeneration) return;
        const image = {
          width: rendered.width,
          height: rendered.height,
          data: rendered.data
        };
        viewer.uploadTexture(pageNumber, image, "full");
        rgbaImageToPngBlob(image).then((blob) => {
          blobCachePut(pageNumber, { blob, width: image.width, height: image.height }, "raw");
          saveRenderCache({
            fileId,
            pageNumber,
            level: "full",
            pngBlob: blob,
            width: image.width,
            height: image.height
          }).catch(() => {
          });
        }).catch(() => {
        });
      }
      hasFullLoaded.add(pageNumber);
      fullGen.set(pageNumber, gen);
      callbacks4.onTextureReady(pageNumber, "full");
    } catch (err) {
      console.error(`full texture upload failed for page ${pageNumber}; falling back to overview:`, err);
      viewer.evictTexture(pageNumber, "full");
      hasFullLoaded.delete(pageNumber);
      fullGen.delete(pageNumber);
      fullFailed.set(pageNumber, viewGeneration);
    } finally {
      loadingFull.delete(pageNumber);
    }
  }
  async function getFullRawImageImpl(pageNumber) {
    try {
      const cached = await getRenderCache(fileId, pageNumber, "full");
      if (cached) {
        return pngBlobToRgbaImage(cached.pngBlob, cached.width, cached.height);
      }
    } catch {
    }
    const rendered = await renderPdfPage(doc, pageNumber, backend, SCALE_200DPI);
    const image = {
      width: rendered.width,
      height: rendered.height,
      data: rendered.data
    };
    rgbaImageToPngBlob(image).then((blob) => {
      saveRenderCache({
        fileId,
        pageNumber,
        level: "full",
        pngBlob: blob,
        width: image.width,
        height: image.height
      }).catch(() => {
      });
    }).catch(() => {
    });
    return image;
  }
  return {
    async loadAll(pages, denoisedPages, onDenoisedFailed) {
      denoisedPageSet.clear();
      for (const p of denoisedPages) denoisedPageSet.add(p);
      reportDenoisedFailed = onDenoisedFailed;
      for (const page of pages) {
        pageDims.set(page.pageNumber, { width: page.fullWidth, height: page.fullHeight });
        if (denoisedPages.has(page.pageNumber)) {
          const loaded = await loadDenoisedThumbnail(page);
          if (loaded) {
            callbacks4.onTextureReady(page.pageNumber, "thumbnail");
            continue;
          }
          let denoisedHandled = false;
          try {
            const stored = await getDenoisedImage(fileId, page.pageNumber);
            if (stored) {
              if (!dimsMatch(stored.width, page.fullWidth) || !dimsMatch(stored.height, page.fullHeight)) {
                console.warn(`Deleting stale denoised image for page ${page.pageNumber}: ${stored.width}\xD7${stored.height} vs expected ${page.fullWidth}\xD7${page.fullHeight}`);
                await deleteDenoisedImage(fileId, page.pageNumber);
                denoisedPageSet.delete(page.pageNumber);
                onDenoisedFailed?.(page.pageNumber);
              } else {
                const thScale = THUMBNAIL_DPI / 200;
                const tw = Math.round(stored.width * thScale);
                const th = Math.round(stored.height * thScale);
                const thBitmap = await createImageBitmap(stored.pngBlob, {
                  resizeWidth: tw,
                  resizeHeight: th,
                  resizeQuality: "high"
                });
                viewer.uploadBitmap(page.pageNumber, thBitmap, "thumbnail", thScale);
                thumbnailScales.set(page.pageNumber, thScale);
                hasThumbnailLoaded.add(page.pageNumber);
                thumbnailGen.set(page.pageNumber, viewGeneration);
                const thCanvas = new OffscreenCanvas(tw, th);
                const thCtx = thCanvas.getContext("2d");
                thCtx.drawImage(thBitmap, 0, 0);
                thBitmap.close();
                thCanvas.convertToBlob({ type: "image/png" }).then((thBlob) => {
                  saveRenderCache({
                    fileId,
                    pageNumber: page.pageNumber,
                    level: "denoisedThumbnail",
                    pngBlob: thBlob,
                    width: tw,
                    height: th
                  }).catch(() => {
                  });
                }).catch(() => {
                });
                blobCachePut(page.pageNumber, { blob: stored.pngBlob, width: stored.width, height: stored.height }, "denoised");
                denoisedHandled = true;
              }
            }
          } catch (err) {
            console.error(`Failed to load denoised image for page ${page.pageNumber}:`, err);
            try {
              await deleteDenoisedImage(fileId, page.pageNumber);
            } catch {
            }
            denoisedPageSet.delete(page.pageNumber);
            onDenoisedFailed?.(page.pageNumber);
          }
          if (!denoisedHandled) {
            await loadThumbnail(page);
          }
          callbacks4.onTextureReady(page.pageNumber, "thumbnail");
        } else {
          await loadThumbnail(page);
          callbacks4.onTextureReady(page.pageNumber, "thumbnail");
        }
      }
    },
    requestThumbnail(pageNumber) {
      if (suspended || loadingThumbnail.has(pageNumber)) return;
      if (!stale(thumbnailGen, hasThumbnailLoaded, pageNumber)) return;
      if (!pageDims.has(pageNumber)) return;
      loadingThumbnail.add(pageNumber);
      loadThumbnail({ pageNumber }).then(() => {
        loadingThumbnail.delete(pageNumber);
        callbacks4.onTextureReady(pageNumber, "thumbnail");
      }).catch((err) => {
        loadingThumbnail.delete(pageNumber);
        console.error(`Failed to reload thumbnail for page ${pageNumber}:`, err);
      });
    },
    requestOverview(pageNumber) {
      loadOverviewTexture(pageNumber).catch((err) => {
        console.error(`Failed to load overview texture for page ${pageNumber}:`, err);
      });
    },
    requestFull(pageNumber) {
      loadFull(pageNumber).catch((err) => {
        console.error(`Failed to load full texture for page ${pageNumber}:`, err);
      });
    },
    evictInvisible(visiblePages) {
      for (const pageNum of hasOverviewLoaded) {
        if (!visiblePages.has(pageNum)) {
          viewer.evictTexture(pageNum, "overview");
          hasOverviewLoaded.delete(pageNum);
          overviewGen.delete(pageNum);
        }
      }
      for (const pageNum of hasFullLoaded) {
        if (!visiblePages.has(pageNum)) {
          viewer.evictTexture(pageNum, "full");
          hasFullLoaded.delete(pageNum);
          fullGen.delete(pageNum);
          fullFailed.delete(pageNum);
        }
      }
      if (hasThumbnailLoaded.size > MAX_THUMBNAILS) {
        for (const pageNum of hasThumbnailLoaded) {
          if (!visiblePages.has(pageNum)) {
            viewer.evictTexture(pageNum, "thumbnail");
            hasThumbnailLoaded.delete(pageNum);
            thumbnailGen.delete(pageNum);
          }
        }
      }
    },
    needsOverviewTexture(pageNumber, zoom) {
      if (suspended || loadingOverview.has(pageNumber)) return false;
      if (!stale(overviewGen, hasOverviewLoaded, pageNumber)) return false;
      const scale = thumbnailScales.get(pageNumber) ?? 0.25;
      return zoom * scale > OVERVIEW_THRESHOLD;
    },
    needsFullTexture(pageNumber, zoom) {
      if (suspended || loadingFull.has(pageNumber)) return false;
      if (fullFailed.get(pageNumber) === viewGeneration) return false;
      if (!stale(fullGen, hasFullLoaded, pageNumber)) return false;
      const scale = overviewScales.get(pageNumber) ?? 0.5;
      return zoom * scale > FULL_TEXTURE_THRESHOLD;
    },
    updateDenoised(pageNumber, denoisedFull, denoisedBlob) {
      denoisedPageSet.add(pageNumber);
      const ovScale = OVERVIEW_DPI / 200;
      const ow = Math.round(denoisedFull.width * ovScale);
      const oh = Math.round(denoisedFull.height * ovScale);
      const overviewData = downsample(denoisedFull, ow, oh);
      viewer.uploadTexture(pageNumber, overviewData, "overview", ovScale);
      overviewScales.set(pageNumber, ovScale);
      hasOverviewLoaded.add(pageNumber);
      overviewGen.set(pageNumber, viewGeneration);
      const thScale = THUMBNAIL_DPI / 200;
      const tw = Math.round(denoisedFull.width * thScale);
      const th = Math.round(denoisedFull.height * thScale);
      const thumbnailData = downsample(denoisedFull, tw, th);
      viewer.uploadTexture(pageNumber, thumbnailData, "thumbnail", thScale);
      thumbnailScales.set(pageNumber, thScale);
      hasThumbnailLoaded.add(pageNumber);
      thumbnailGen.set(pageNumber, viewGeneration);
      viewer.evictTexture(pageNumber, "full");
      hasFullLoaded.delete(pageNumber);
      fullGen.delete(pageNumber);
      if (denoisedBlob) {
        blobCachePut(pageNumber, { blob: denoisedBlob, width: denoisedFull.width, height: denoisedFull.height }, "denoised");
      } else {
        rgbaImageToPngBlob(denoisedFull).then((blob) => {
          blobCachePut(pageNumber, { blob, width: denoisedFull.width, height: denoisedFull.height }, "denoised");
        }).catch(() => {
        });
      }
      rgbaImageToPngBlob(thumbnailData).then((thBlob) => {
        saveRenderCache({
          fileId,
          pageNumber,
          level: "denoisedThumbnail",
          pngBlob: thBlob,
          width: tw,
          height: th
        }).catch(() => {
        });
      }).catch(() => {
      });
      rgbaImageToPngBlob(overviewData).then((ovBlob) => {
        saveRenderCache({
          fileId,
          pageNumber,
          level: "denoisedOverview",
          pngBlob: ovBlob,
          width: ow,
          height: oh
        }).catch(() => {
        });
      }).catch(() => {
      });
    },
    getOverviewScale(pageNumber) {
      return overviewScales.get(pageNumber) ?? 0.5;
    },
    async getFullImage(pageNumber) {
      const cached = blobCacheGet(pageNumber, "denoised");
      try {
        const stored = await getDenoisedImage(fileId, pageNumber);
        if (stored) {
          const raw = cached ? { width: cached.width, height: cached.height } : await getFullRawImageImpl(pageNumber);
          if (dimsMatch(stored.width, raw.width) && dimsMatch(stored.height, raw.height)) {
            return pngBlobToRgbaImage(stored.pngBlob, stored.width, stored.height);
          }
          if ("data" in raw) return raw;
        }
      } catch {
      }
      return getFullRawImageImpl(pageNumber);
    },
    async getFullRawImage(pageNumber) {
      return getFullRawImageImpl(pageNumber);
    },
    async getThumbnailImage(pageNumber) {
      for (const level of ["denoisedThumbnail", "thumbnail"]) {
        try {
          const cached = await getRenderCache(fileId, pageNumber, level);
          if (cached) {
            const image = await pngBlobToRgbaImage(cached.pngBlob, cached.width, cached.height);
            return { image, dpi: THUMBNAIL_DPI };
          }
        } catch {
        }
      }
      const scale = THUMBNAIL_DPI / 72;
      const rendered = await renderPdfPage(doc, pageNumber, backend, scale);
      return {
        image: { width: rendered.width, height: rendered.height, data: rendered.data },
        dpi: THUMBNAIL_DPI
      };
    },
    setViewMode(mode) {
      if (viewMode === mode) return;
      viewMode = mode;
      invalidateView();
    },
    setSuspended(value) {
      suspended = value;
    },
    destroy() {
      viewGeneration++;
      for (const pageNum of hasThumbnailLoaded) viewer.evictTexture(pageNum, "thumbnail");
      for (const pageNum of hasOverviewLoaded) viewer.evictTexture(pageNum, "overview");
      for (const pageNum of hasFullLoaded) viewer.evictTexture(pageNum, "full");
      thumbnailScales.clear();
      overviewScales.clear();
      loadingThumbnail.clear();
      hasThumbnailLoaded.clear();
      loadingOverview.clear();
      hasOverviewLoaded.clear();
      loadingFull.clear();
      hasFullLoaded.clear();
      thumbnailGen.clear();
      overviewGen.clear();
      fullGen.clear();
      fullFailed.clear();
      pageDims.clear();
      blobCache.clear();
      denoisedPageSet.clear();
      blobCacheOrder.length = 0;
    }
  };
}

// browser-app/ui/page_layout.ts
var PAGE_GAP = 50;
function computePageLayout(selectedPages, pageSizes, dpi, cropRects) {
  const pages = [];
  let yOffset = 0;
  let maxWidth = 0;
  for (const pageNum of selectedPages) {
    const size = pageSizes[pageNum - 1];
    const fullWidthInches = size.widthPt / 72;
    const fullHeightInches = size.heightPt / 72;
    const fullWidth = Math.round(snapToCleanUnit(fullWidthInches, dpi) * dpi);
    const fullHeight = Math.round(snapToCleanUnit(fullHeightInches, dpi) * dpi);
    const crop = cropRects?.get(pageNum);
    const width = crop ? crop.width : fullWidth;
    const height = crop ? crop.height : fullHeight;
    const srcX = crop ? crop.x : 0;
    const srcY = crop ? crop.y : 0;
    const widthInches = width / dpi;
    const heightInches = height / dpi;
    pages.push({
      pageNumber: pageNum,
      width,
      height,
      widthInches,
      heightInches,
      yOffset,
      fullWidth,
      fullHeight,
      srcX,
      srcY
    });
    maxWidth = Math.max(maxWidth, width);
    yOffset += height + PAGE_GAP;
  }
  const totalHeight = yOffset > 0 ? yOffset - PAGE_GAP : 0;
  return { pages, totalHeight, maxWidth };
}
function visiblePageRange(layout, viewportTop, viewportBottom) {
  let first = -1;
  let last = -1;
  for (let i = 0; i < layout.pages.length; i++) {
    const page = layout.pages[i];
    const pageTop = page.yOffset;
    const pageBottom = page.yOffset + page.height;
    if (pageBottom > viewportTop && pageTop < viewportBottom) {
      if (first === -1) first = i;
      last = i;
    }
  }
  return [first, last];
}
function pageClosestToCenter(layout, viewportCenterY) {
  if (layout.pages.length === 0) return null;
  let closest = null;
  let closestDist = Infinity;
  for (const page of layout.pages) {
    const pageCenterY = page.yOffset + page.height / 2;
    const dist3 = Math.abs(pageCenterY - viewportCenterY);
    if (dist3 < closestDist) {
      closestDist = dist3;
      closest = page;
    }
  }
  return closest;
}

// browser-app/ui/crop_overlay.ts
var overlayCanvas;
var ctx;
var containerEl;
var enabled = false;
var dragMode = "none";
var dragStartImgX = 0;
var dragStartImgY = 0;
var dragStartRect = { x: 0, y: 0, width: 0, height: 0 };
var dragPageNumber = 0;
var onCropChanged = null;
var HANDLE_SIZE = 8;
var HIT_TOLERANCE = 10;
function initCropOverlay(container2, canvas2, onChange) {
  containerEl = container2;
  overlayCanvas = canvas2;
  ctx = canvas2.getContext("2d");
  onCropChanged = onChange ?? null;
  overlayCanvas.addEventListener("mousedown", onMouseDown);
  window.addEventListener("mousemove", onMouseMove);
  window.addEventListener("mouseup", onMouseUp);
}
function setCropEnabled(value) {
  enabled = value;
  overlayCanvas.style.pointerEvents = value ? "auto" : "none";
}
function screenToVirtual(screenX, screenY) {
  const rect = containerEl.getBoundingClientRect();
  const mx = screenX - rect.left;
  const my = screenY - rect.top;
  return [
    (mx - state.panX) / state.zoom,
    (my - state.panY) / state.zoom
  ];
}
function pageImageToScreen(imgX, imgY, page, layout) {
  const pageLeft = (layout.maxWidth - page.width) / 2;
  const vx = pageLeft + imgX;
  const vy = page.yOffset + imgY;
  return [
    vx * state.zoom + state.panX,
    vy * state.zoom + state.panY
  ];
}
function screenToPageImage(screenX, screenY, page, layout) {
  const [vx, vy] = screenToVirtual(screenX, screenY);
  const pageLeft = (layout.maxWidth - page.width) / 2;
  return [vx - pageLeft, vy - page.yOffset];
}
function resizeOverlayCanvas(cssW, cssH, dpr) {
  const w = Math.round(cssW * dpr);
  const h = Math.round(cssH * dpr);
  if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
    overlayCanvas.width = w;
    overlayCanvas.height = h;
    overlayCanvas.style.width = `${Math.round(cssW)}px`;
    overlayCanvas.style.height = `${Math.round(cssH)}px`;
  }
}
function drawCropOverlay() {
  const layout = state.pageLayout;
  if (!layout || layout.pages.length === 0) return;
  if (state.cropRects.size === 0) {
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const cw = overlayCanvas.width;
  const ch = overlayCanvas.height;
  ctx.clearRect(0, 0, cw, ch);
  if (!enabled && dragMode === "none") return;
  const viewportTop = -state.panY / state.zoom;
  const viewportBottom = (ch / dpr - state.panY) / state.zoom;
  const [firstIdx, lastIdx] = visiblePageRange(layout, viewportTop, viewportBottom);
  if (firstIdx < 0) return;
  for (let i = firstIdx; i <= lastIdx; i++) {
    const page = layout.pages[i];
    const crop = state.cropRects.get(page.pageNumber);
    if (!crop) continue;
    drawPageCropRect(page, crop, layout, dpr, cw, ch);
  }
}
function drawPageCropRect(page, crop, layout, dpr, _cw, _ch) {
  const [sx1, sy1] = pageImageToScreen(crop.x, crop.y, page, layout);
  const [sx2, sy2] = pageImageToScreen(crop.x + crop.width, crop.y + crop.height, page, layout);
  const left = sx1 * dpr;
  const top = sy1 * dpr;
  const right = sx2 * dpr;
  const bottom = sy2 * dpr;
  ctx.strokeStyle = "rgba(74, 158, 255, 0.9)";
  ctx.lineWidth = 2 * dpr;
  ctx.strokeRect(left, top, right - left, bottom - top);
  const [psx1, psy1] = pageImageToScreen(0, 0, page, layout);
  const [psx2, psy2] = pageImageToScreen(page.width, page.height, page, layout);
  const pLeft = psx1 * dpr;
  const pTop = psy1 * dpr;
  const pRight = psx2 * dpr;
  const pBottom = psy2 * dpr;
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(pLeft, pTop, pRight - pLeft, top - pTop);
  ctx.fillRect(pLeft, bottom, pRight - pLeft, pBottom - bottom);
  ctx.fillRect(pLeft, top, left - pLeft, bottom - top);
  ctx.fillRect(right, top, pRight - right, bottom - top);
  const hs = HANDLE_SIZE * dpr;
  const half = hs / 2;
  const midX = (left + right) / 2;
  const midY = (top + bottom) / 2;
  ctx.fillStyle = "rgba(74, 158, 255, 1)";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1 * dpr;
  const handles = [
    [left, top],
    [right, top],
    [left, bottom],
    [right, bottom],
    [midX, top],
    [midX, bottom],
    [left, midY],
    [right, midY]
  ];
  for (const [hx, hy] of handles) {
    ctx.fillRect(hx - half, hy - half, hs, hs);
    ctx.strokeRect(hx - half, hy - half, hs, hs);
  }
}
function hitTestAnyPage(screenX, screenY) {
  const layout = state.pageLayout;
  if (!layout) return { mode: "none", pageNumber: 0 };
  const rect = containerEl.getBoundingClientRect();
  const mx = screenX - rect.left;
  const my = screenY - rect.top;
  const t = HIT_TOLERANCE;
  for (const page of layout.pages) {
    const crop = state.cropRects.get(page.pageNumber);
    if (!crop) continue;
    const [sx1, sy1] = pageImageToScreen(crop.x, crop.y, page, layout);
    const [sx2, sy2] = pageImageToScreen(crop.x + crop.width, crop.y + crop.height, page, layout);
    const midX = (sx1 + sx2) / 2;
    const midY = (sy1 + sy2) / 2;
    if (Math.abs(mx - sx1) < t && Math.abs(my - sy1) < t) return { mode: "nw", pageNumber: page.pageNumber };
    if (Math.abs(mx - sx2) < t && Math.abs(my - sy1) < t) return { mode: "ne", pageNumber: page.pageNumber };
    if (Math.abs(mx - sx1) < t && Math.abs(my - sy2) < t) return { mode: "sw", pageNumber: page.pageNumber };
    if (Math.abs(mx - sx2) < t && Math.abs(my - sy2) < t) return { mode: "se", pageNumber: page.pageNumber };
    if (Math.abs(mx - midX) < t && Math.abs(my - sy1) < t) return { mode: "n", pageNumber: page.pageNumber };
    if (Math.abs(mx - midX) < t && Math.abs(my - sy2) < t) return { mode: "s", pageNumber: page.pageNumber };
    if (Math.abs(mx - sx1) < t && Math.abs(my - midY) < t) return { mode: "w", pageNumber: page.pageNumber };
    if (Math.abs(mx - sx2) < t && Math.abs(my - midY) < t) return { mode: "e", pageNumber: page.pageNumber };
    if (mx >= sx1 && mx <= sx2 && my >= sy1 && my <= sy2) return { mode: "move", pageNumber: page.pageNumber };
  }
  return { mode: "none", pageNumber: 0 };
}
function getCursorForMode(mode) {
  switch (mode) {
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "move":
      return "move";
    default:
      return "";
  }
}
function clampRectToPage(rect, pageW, pageH) {
  let { x, y, width, height } = rect;
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x + width > pageW) {
    if (width > pageW) {
      x = 0;
      width = pageW;
    } else x = pageW - width;
  }
  if (y + height > pageH) {
    if (height > pageH) {
      y = 0;
      height = pageH;
    } else y = pageH - height;
  }
  return { x, y, width, height };
}
function applyRectToAllPages(rect) {
  const layout = state.pageLayout;
  if (!layout) return;
  for (const page of layout.pages) {
    state.cropRects.set(page.pageNumber, clampRectToPage(rect, page.width, page.height));
  }
}
function onMouseDown(e) {
  if (!enabled || e.button !== 0) return;
  const layout = state.pageLayout;
  if (!layout) return;
  const { mode, pageNumber } = hitTestAnyPage(e.clientX, e.clientY);
  if (mode === "none") return;
  e.preventDefault();
  e.stopPropagation();
  const page = layout.pages.find((p) => p.pageNumber === pageNumber);
  if (!page) return;
  dragMode = mode;
  dragPageNumber = pageNumber;
  const [imgX, imgY] = screenToPageImage(e.clientX, e.clientY, page, layout);
  dragStartImgX = imgX;
  dragStartImgY = imgY;
  dragStartRect = { ...state.cropRects.get(pageNumber) };
  overlayCanvas.style.cursor = getCursorForMode(mode);
}
function onMouseMove(e) {
  if (!enabled) return;
  if (dragMode === "none") {
    const { mode } = hitTestAnyPage(e.clientX, e.clientY);
    overlayCanvas.style.cursor = getCursorForMode(mode);
    return;
  }
  e.preventDefault();
  const layout = state.pageLayout;
  if (!layout) return;
  const page = layout.pages.find((p) => p.pageNumber === dragPageNumber);
  if (!page) return;
  const [imgX, imgY] = screenToPageImage(e.clientX, e.clientY, page, layout);
  const dx = imgX - dragStartImgX;
  const dy = imgY - dragStartImgY;
  const r = dragStartRect;
  const minSize = 50;
  let nx = r.x;
  let ny = r.y;
  let nw = r.width;
  let nh = r.height;
  switch (dragMode) {
    case "move":
      nx = r.x + dx;
      ny = r.y + dy;
      break;
    case "nw":
      nx = r.x + dx;
      ny = r.y + dy;
      nw = r.width - dx;
      nh = r.height - dy;
      break;
    case "ne":
      ny = r.y + dy;
      nw = r.width + dx;
      nh = r.height - dy;
      break;
    case "sw":
      nx = r.x + dx;
      nw = r.width - dx;
      nh = r.height + dy;
      break;
    case "se":
      nw = r.width + dx;
      nh = r.height + dy;
      break;
    case "n":
      ny = r.y + dy;
      nh = r.height - dy;
      break;
    case "s":
      nh = r.height + dy;
      break;
    case "w":
      nx = r.x + dx;
      nw = r.width - dx;
      break;
    case "e":
      nw = r.width + dx;
      break;
  }
  if (nw < minSize) {
    if (dragMode === "nw" || dragMode === "w" || dragMode === "sw") {
      nx = r.x + r.width - minSize;
    }
    nw = minSize;
  }
  if (nh < minSize) {
    if (dragMode === "nw" || dragMode === "n" || dragMode === "ne") {
      ny = r.y + r.height - minSize;
    }
    nh = minSize;
  }
  const pageW = page.width;
  const pageH = page.height;
  if (nx < 0) {
    if (dragMode === "move") nw = r.width;
    nx = 0;
  }
  if (ny < 0) {
    if (dragMode === "move") nh = r.height;
    ny = 0;
  }
  if (nx + nw > pageW) {
    if (dragMode === "move") nx = pageW - nw;
    else nw = pageW - nx;
  }
  if (ny + nh > pageH) {
    if (dragMode === "move") ny = pageH - nh;
    else nh = pageH - ny;
  }
  const newRect = {
    x: Math.round(nx),
    y: Math.round(ny),
    width: Math.round(nw),
    height: Math.round(nh)
  };
  if (state.cropLocked) {
    applyRectToAllPages(newRect);
  } else {
    state.cropRects.set(dragPageNumber, newRect);
  }
  drawCropOverlay();
}
function onMouseUp(_e) {
  if (dragMode === "none") return;
  dragMode = "none";
  dragPageNumber = 0;
  overlayCanvas.style.cursor = "";
  if (onCropChanged) {
    const firstRect = state.cropRects.values().next().value;
    if (firstRect) onCropChanged({ ...firstRect });
  }
}

// browser-app/ui/viewer.ts
var canvas;
var graphOverlayCanvas;
var container;
var multiPageViewer = null;
var graphOverlay = null;
var texManager = null;
var gpuReady;
var elZoomLevel = null;
var containerW = 0;
var containerH = 0;
var isPanning = false;
var panStartX = 0;
var panStartY = 0;
var touchPrevDist = 0;
var touchPrevMidX = 0;
var touchPrevMidY = 0;
var isTouchPanning = false;
var touchLastX = 0;
var touchLastY = 0;
var viewerCallbacks;
var minimapCanvas;
var minimapCtx;
var minimapContainer;
var MINIMAP_MAX_DIM = 160;
var isUserScrolling = false;
var scrollIdleTimer;
var SCROLL_IDLE_MS = 200;
function markScrollActive() {
  isUserScrolling = true;
  clearTimeout(scrollIdleTimer);
  scrollIdleTimer = setTimeout(() => {
    isUserScrolling = false;
    scheduleRedraw();
  }, SCROLL_IDLE_MS);
}
var targetZoom = 1;
var targetPanX = 0;
var targetPanY = 0;
var animating = false;
var lastInputTime = 0;
var ANIM_LERP = 0.25;
var KEEP_ALIVE_MS = 200;
var ANIM_EPS_PX = 0.1;
var ANIM_EPS_ZOOM = 5e-4;
function startAnimationLoop() {
  lastInputTime = performance.now();
  if (animating) return;
  animating = true;
  requestAnimationFrame(animationTick);
}
function animationTick() {
  const now2 = performance.now();
  const dZoom = targetZoom - state.zoom;
  const dPanX = targetPanX - state.panX;
  const dPanY = targetPanY - state.panY;
  const converged = Math.abs(dZoom) < ANIM_EPS_ZOOM && Math.abs(dPanX) < ANIM_EPS_PX && Math.abs(dPanY) < ANIM_EPS_PX;
  if (converged) {
    state.zoom = targetZoom;
    state.panX = targetPanX;
    state.panY = targetPanY;
  } else {
    state.zoom += dZoom * ANIM_LERP;
    state.panX += dPanX * ANIM_LERP;
    state.panY += dPanY * ANIM_LERP;
  }
  redraw();
  if (!converged || now2 - lastInputTime < KEEP_ALIVE_MS) {
    requestAnimationFrame(animationTick);
  } else {
    animating = false;
    redraw();
  }
}
function ensureContainerSize() {
  if (containerW > 0 && containerH > 0) return;
  const r = container.getBoundingClientRect();
  containerW = r.width;
  containerH = r.height;
}
var MAX_ZOOM = 256;
function minZoom() {
  const layout = state.pageLayout;
  if (!layout || layout.pages.length === 0) return 0.01;
  ensureContainerSize();
  const padding = 40;
  const scaleX = (containerW - padding) / layout.maxWidth;
  const scaleY = (containerH - padding) / layout.totalHeight;
  return Math.min(scaleX, scaleY);
}
function clampPan(px, py, zoom) {
  const layout = state.pageLayout;
  if (!layout) return [px, py];
  ensureContainerSize();
  if (containerW < 1 || containerH < 1) return [px, py];
  const margin = 0.5;
  const contentW = layout.maxWidth * zoom;
  const contentH = layout.totalHeight * zoom;
  const maxX = containerW * margin;
  const minX = containerW * (1 - margin) - contentW;
  const maxY = containerH * margin;
  const minY = containerH * (1 - margin) - contentH;
  return [
    Math.max(minX, Math.min(maxX, px)),
    Math.max(minY, Math.min(maxY, py))
  ];
}
function applyZoom(factor, clientX, clientY) {
  const newZoom = Math.max(minZoom(), Math.min(MAX_ZOOM, targetZoom * factor));
  const rect = container.getBoundingClientRect();
  const mx = clientX - rect.left;
  const my = clientY - rect.top;
  targetPanX = mx - (mx - targetPanX) * (newZoom / targetZoom);
  targetPanY = my - (my - targetPanY) * (newZoom / targetZoom);
  targetZoom = newZoom;
  [targetPanX, targetPanY] = clampPan(targetPanX, targetPanY, targetZoom);
  startAnimationLoop();
}
async function initGPU() {
  const gpuCtx = await getGPUContext();
  multiPageViewer = createMultiPageViewer(canvas, gpuCtx);
  graphOverlay = createGraphOverlay(graphOverlayCanvas, gpuCtx);
  graphOverlay.setVisible(false);
}
function initViewer(callbacks4) {
  canvas = document.getElementById("viewerCanvas");
  graphOverlayCanvas = document.getElementById("graphOverlayCanvas");
  container = document.getElementById("viewerContainer");
  ;
  viewerCallbacks = callbacks4;
  minimapCanvas = document.getElementById("minimapCanvas");
  minimapCtx = minimapCanvas.getContext("2d");
  minimapContainer = document.getElementById("minimapContainer");
  const cropCanvas = document.getElementById("cropOverlayCanvas");
  initCropOverlay(container, cropCanvas, (rect) => callbacks4.onCropChanged(rect));
  elZoomLevel = document.getElementById("viewerZoomLevel");
  gpuReady = initGPU();
  const backBtn = document.getElementById("backToPagesBtn");
  backBtn.addEventListener("click", callbacks4.onBackToPages);
  container.addEventListener("wheel", (e) => {
    e.preventDefault();
    markScrollActive();
    if (e.ctrlKey) {
      const zoomFactor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      applyZoom(zoomFactor, e.clientX, e.clientY);
    } else {
      state.panX -= e.deltaX;
      state.panY -= e.deltaY;
      [state.panX, state.panY] = clampPan(state.panX, state.panY, state.zoom);
      targetPanX = state.panX;
      targetPanY = state.panY;
      startAnimationLoop();
    }
  }, { passive: false });
  container.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (e.touches.length === 2) {
      const t02 = e.touches[0];
      const t1 = e.touches[1];
      touchPrevDist = Math.hypot(t1.clientX - t02.clientX, t1.clientY - t02.clientY);
      touchPrevMidX = (t02.clientX + t1.clientX) / 2;
      touchPrevMidY = (t02.clientY + t1.clientY) / 2;
      isTouchPanning = false;
    } else if (e.touches.length === 1) {
      isTouchPanning = true;
      touchLastX = e.touches[0].clientX;
      touchLastY = e.touches[0].clientY;
    }
  }, { passive: false });
  container.addEventListener("touchmove", (e) => {
    e.preventDefault();
    markScrollActive();
    if (e.touches.length === 2) {
      const t02 = e.touches[0];
      const t1 = e.touches[1];
      const dist3 = Math.hypot(t1.clientX - t02.clientX, t1.clientY - t02.clientY);
      const midX = (t02.clientX + t1.clientX) / 2;
      const midY = (t02.clientY + t1.clientY) / 2;
      if (touchPrevDist > 0) {
        targetPanX += midX - touchPrevMidX;
        targetPanY += midY - touchPrevMidY;
        applyZoom(dist3 / touchPrevDist, midX, midY);
      }
      touchPrevDist = dist3;
      touchPrevMidX = midX;
      touchPrevMidY = midY;
    } else if (e.touches.length === 1 && isTouchPanning) {
      const tx = e.touches[0].clientX;
      const ty = e.touches[0].clientY;
      state.panX += tx - touchLastX;
      state.panY += ty - touchLastY;
      [state.panX, state.panY] = clampPan(state.panX, state.panY, state.zoom);
      targetPanX = state.panX;
      targetPanY = state.panY;
      touchLastX = tx;
      touchLastY = ty;
      scheduleRedraw();
    }
  }, { passive: false });
  container.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (e.touches.length < 2) {
      touchPrevDist = 0;
    }
    if (e.touches.length === 0) {
      isTouchPanning = false;
    } else if (e.touches.length === 1) {
      isTouchPanning = true;
      touchLastX = e.touches[0].clientX;
      touchLastY = e.touches[0].clientY;
    }
  }, { passive: false });
  container.addEventListener("touchcancel", () => {
    touchPrevDist = 0;
    isTouchPanning = false;
  });
  container.addEventListener("mousedown", (e) => {
    if (e.button === 0 || e.button === 1) {
      e.preventDefault();
      isPanning = true;
      panStartX = e.clientX - state.panX;
      panStartY = e.clientY - state.panY;
      container.style.cursor = "grabbing";
    }
  });
  window.addEventListener("mousemove", (e) => {
    if (!isPanning) return;
    markScrollActive();
    state.panX = e.clientX - panStartX;
    state.panY = e.clientY - panStartY;
    [state.panX, state.panY] = clampPan(state.panX, state.panY, state.zoom);
    targetPanX = state.panX;
    targetPanY = state.panY;
    scheduleRedraw();
  });
  window.addEventListener("mouseup", () => {
    if (isPanning) {
      isPanning = false;
      container.style.cursor = "";
      scheduleRedraw();
    }
  });
  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.contentBoxSize?.length) {
        containerW = entry.contentBoxSize[0].inlineSize;
        containerH = entry.contentBoxSize[0].blockSize;
      } else {
        const r = container.getBoundingClientRect();
        containerW = r.width;
        containerH = r.height;
      }
    }
    scheduleRedraw();
  });
  resizeObserver.observe(container);
}
async function enterMultiPageView(layout, doc, backend, fileId, denoisedPages, onDenoisedFailed) {
  state.pageLayout = layout;
  await gpuReady;
  texManager?.destroy();
  multiPageViewer?.destroy();
  texManager = createTextureManager(
    multiPageViewer,
    {
      onTextureReady(_pageNumber, _level) {
        scheduleRedraw();
      }
    },
    doc,
    backend,
    fileId
  );
  ensureContainerSize();
  const padding = 40;
  state.zoom = Math.min((containerW - padding) / layout.maxWidth, 1);
  state.panX = (containerW - layout.maxWidth * state.zoom) / 2;
  state.panY = padding / 2;
  targetZoom = state.zoom;
  targetPanX = state.panX;
  targetPanY = state.panY;
  scheduleRedraw();
  texManager.loadAll(layout.pages, denoisedPages, onDenoisedFailed).catch((err) => {
    console.error("Failed to load thumbnails:", err);
  });
}
function setInkSources(sources, palette) {
  if (!multiPageViewer) return;
  multiPageViewer.clearInkSources();
  if (palette) multiPageViewer.setInkPalette(palette.colors, palette.background);
  for (const [pageNumber, src] of sources) multiPageViewer.setInkSource(pageNumber, src);
  scheduleRedraw();
}
function getTextureManager() {
  return texManager;
}
function updateLayout(layout) {
  state.pageLayout = layout;
  ensureContainerSize();
  const padding = 40;
  const newZoom = Math.min((containerW - padding) / layout.maxWidth, 1);
  state.zoom = newZoom;
  state.panX = (containerW - layout.maxWidth * newZoom) / 2;
  state.panY = padding / 2;
  targetZoom = newZoom;
  targetPanX = state.panX;
  targetPanY = state.panY;
  scheduleRedraw();
}
var redrawScheduled = false;
function scheduleRedraw() {
  if (redrawScheduled) return;
  redrawScheduled = true;
  requestAnimationFrame(() => {
    redrawScheduled = false;
    redraw();
  });
}
function requestRedraw() {
  scheduleRedraw();
}
var _lastDomUpdateTime = 0;
var _lastZoomText = "";
var _lastMinimapTime = 0;
function redraw() {
  if (!multiPageViewer) return;
  const layout = state.pageLayout;
  if (!layout || layout.pages.length === 0) return;
  if (containerW < 1 || containerH < 1) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = Math.round(containerW);
  const cssH = Math.round(containerH);
  const cw = Math.round(containerW * dpr);
  const ch = Math.round(containerH * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
  }
  const viewportTop = -state.panY / state.zoom;
  const viewportBottom = (containerH - state.panY) / state.zoom;
  const [firstIdx, lastIdx] = visiblePageRange(layout, viewportTop, viewportBottom);
  multiPageViewer.render(layout, [firstIdx, lastIdx], state.panX, state.panY, state.zoom, dpr);
  if (texManager && firstIdx >= 0) {
    const visibleSet = /* @__PURE__ */ new Set();
    for (let i = firstIdx; i <= lastIdx; i++) {
      const pageNum = layout.pages[i].pageNumber;
      visibleSet.add(pageNum);
      texManager.requestThumbnail(pageNum);
      if (!isUserScrolling) {
        if (texManager.needsOverviewTexture(pageNum, state.zoom)) {
          texManager.requestOverview(pageNum);
        }
        if (texManager.needsFullTexture(pageNum, state.zoom)) {
          texManager.requestFull(pageNum);
        }
      }
    }
    texManager.evictInvisible(visibleSet);
  }
  const viewportCenterY = (containerH / 2 - state.panY) / state.zoom;
  const closest = pageClosestToCenter(layout, viewportCenterY);
  if (closest && closest.pageNumber !== state.activePageNumber) {
    state.activePageNumber = closest.pageNumber;
    state.selectedPage = closest.pageNumber;
    viewerCallbacks.onActivePageChanged(closest.pageNumber);
  }
  const t02 = performance.now();
  if (t02 - _lastDomUpdateTime > 100) {
    const zoomText = `${Math.round(state.zoom * 100)}%`;
    if (elZoomLevel && zoomText !== _lastZoomText) {
      elZoomLevel.textContent = zoomText;
      _lastZoomText = zoomText;
    }
    _lastDomUpdateTime = t02;
  }
  if (t02 - _lastMinimapTime > 50) {
    updateMinimap(layout);
    _lastMinimapTime = t02;
  }
  if (graphOverlay) {
    if (graphOverlayCanvas.width !== cw || graphOverlayCanvas.height !== ch) {
      graphOverlayCanvas.width = cw;
      graphOverlayCanvas.height = ch;
      graphOverlayCanvas.style.width = `${cssW}px`;
      graphOverlayCanvas.style.height = `${cssH}px`;
    }
    graphOverlay.render(state.panX, state.panY, state.zoom, dpr);
  }
  resizeOverlayCanvas(containerW, containerH, dpr);
  drawCropOverlay();
}
function updateMinimap(layout) {
  if (layout.pages.length === 0) {
    minimapContainer.style.display = "none";
    return;
  }
  const virtW = layout.maxWidth;
  const virtH = layout.totalHeight;
  const visLeft = -state.panX / state.zoom;
  const visTop = -state.panY / state.zoom;
  const visWidth = containerW / state.zoom;
  const visHeight = containerH / state.zoom;
  if (visLeft <= 0 && visTop <= 0 && visLeft + visWidth >= virtW && visTop + visHeight >= virtH) {
    minimapContainer.style.display = "none";
    return;
  }
  minimapContainer.style.display = "block";
  const aspect = virtW / virtH;
  let mmW, mmH;
  if (aspect > 1) {
    mmW = MINIMAP_MAX_DIM;
    mmH = MINIMAP_MAX_DIM / aspect;
  } else {
    mmH = MINIMAP_MAX_DIM;
    mmW = MINIMAP_MAX_DIM * aspect;
  }
  minimapCanvas.width = Math.round(mmW);
  minimapCanvas.height = Math.round(mmH);
  minimapCanvas.style.width = `${Math.round(mmW)}px`;
  minimapCanvas.style.height = `${Math.round(mmH)}px`;
  const scaleX = mmW / virtW;
  const scaleY = mmH / virtH;
  minimapCtx.clearRect(0, 0, mmW, mmH);
  minimapCtx.fillStyle = "rgba(255, 255, 255, 0.12)";
  minimapCtx.strokeStyle = "rgba(255, 255, 255, 0.25)";
  minimapCtx.lineWidth = 0.5;
  for (const page of layout.pages) {
    const px = (virtW - page.width) / 2 * scaleX;
    const py = page.yOffset * scaleY;
    const pw = page.width * scaleX;
    const ph = page.height * scaleY;
    minimapCtx.fillRect(px, py, pw, ph);
    minimapCtx.strokeRect(px, py, pw, ph);
  }
  const rx = Math.max(0, visLeft * scaleX);
  const ry = Math.max(0, visTop * scaleY);
  const rw = Math.min(mmW - rx, visWidth * scaleX);
  const rh = Math.min(mmH - ry, visHeight * scaleY);
  minimapCtx.strokeStyle = "rgba(74, 158, 255, 0.8)";
  minimapCtx.lineWidth = 1.5;
  minimapCtx.strokeRect(rx, ry, rw, rh);
}
function updateDenoiseProgress(progress) {
  const bar = document.getElementById("denoiseProgress");
  if (bar) {
    bar.style.width = `${Math.round(progress * 100)}%`;
  }
  const statusEl = document.getElementById("viewerStatus");
  if (statusEl) {
    if (progress < 1) {
      statusEl.textContent = `Denoising: ${Math.round(progress * 100)}%`;
    } else {
      statusEl.textContent = "Denoising complete";
    }
  }
}
function setDenoiseButtonEnabled(enabled2) {
  const btn = document.getElementById("denoiseBtn");
  if (btn) btn.disabled = !enabled2;
}
function updatePaletteProgress(progress) {
  for (const bar of document.querySelectorAll(".palette-progress-bar")) {
    bar.style.width = `${Math.round(progress * 100)}%`;
    const container2 = bar.parentElement;
    if (container2) {
      container2.style.display = progress > 0 && progress < 1 ? "" : "none";
    }
  }
}
function setPaletteButtonsEnabled(enabled2) {
  for (const id of ["extractPaletteBtn", "viewerExtractPaletteBtn"]) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.disabled = !enabled2;
      btn.textContent = enabled2 ? "Extract Palette" : "Extracting\u2026";
    }
  }
}
function onDenoiseComplete() {
  drawCropOverlay();
  const statusEl = document.getElementById("viewerStatus");
  if (statusEl) statusEl.textContent = "Denoising complete";
}
function showFreshPageControls() {
  setDenoiseButtonEnabled(true);
}
function updateGraphOverlay(pages, activeLayer) {
  if (!graphOverlay) return;
  graphOverlay.upload(pages, activeLayer);
}
function setGraphOverlayVisible(visible) {
  if (graphOverlay) graphOverlay.setVisible(visible);
  scheduleRedraw();
}

// browser-app/ui/steps.ts
var STEP_IDS = ["stepPages", "stepDenoise", "stepCrop", "stepPalette"];
var forcedOpen = /* @__PURE__ */ new Set();
function initSteps(onToggle) {
  for (const id of STEP_IDS) {
    const el = document.getElementById(id);
    const head = el?.querySelector(".step-head");
    if (!el || !head) continue;
    head.addEventListener("click", () => {
      if (el.dataset.state !== "done") return;
      if (forcedOpen.has(id)) forcedOpen.delete(id);
      else forcedOpen.add(id);
      applyOpenState(el, id);
      onToggle?.();
    });
  }
}
function applyOpenState(el, id) {
  const open = el.dataset.state !== "done" || forcedOpen.has(id);
  el.classList.toggle("open", open);
}
function updateSteps(values) {
  for (const id of STEP_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    const value = values[id];
    const done = value !== "";
    el.dataset.state = done ? "done" : "pending";
    const valueEl = document.getElementById(`${id}Value`);
    if (valueEl) valueEl.textContent = done ? value : "\u2014";
    if (!done) forcedOpen.delete(id);
    applyOpenState(el, id);
  }
}

// browser-app/main.ts
var browserCanvasBackend = {
  createCanvas(width, height) {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    return c;
  }
};
var screens = {
  upload: document.getElementById("uploadScreen"),
  viewer: document.getElementById("viewerScreen")
};
function showScreen(screen) {
  state.currentScreen = screen;
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle("active", key === screen);
  }
}
function setPagePickerMode(active) {
  const viewerEl = document.getElementById("viewerScreen");
  viewerEl.classList.toggle("page-picker-active", active);
  const selectPagesBtn = document.getElementById("selectPagesBtn");
  if (selectPagesBtn) selectPagesBtn.classList.toggle("current-step", active);
  updatePageGridState(state.selectedPages, state.denoisedPages);
  updateSelectionInfo(state.selectedPages.size, state.denoisedPages.size);
  updateContinueButton();
}
function updateContinueButton() {
  const btn = document.getElementById("continueToViewBtn");
  if (btn) btn.disabled = state.selectedPages.size === 0;
}
function setStatus(msg) {
  state.statusMessage = msg;
  const el = document.getElementById("statusText");
  if (el) el.textContent = msg;
  const el2 = document.getElementById("viewerStatus");
  if (el2 && state.currentScreen === "viewer") el2.textContent = msg;
}
async function ensureOnnxSession() {
  if (state.onnxSession) return;
  setStatus("Loading ONNX denoiser model...");
  try {
    state.onnxSession = await createOnnxSession({
      // Relative to the document, like every other asset — see index.html.
      // `build.ts` copies the models next to it so this resolves in the dev
      // tree and in `dist/` alike.
      f32: new URL("denoiser_f32.onnx", document.baseURI).href,
      f16: new URL("denoiser_f16.onnx", document.baseURI).href,
      int8: new URL("denoiser_int8.onnx", document.baseURI).href,
      receptiveField: 45
      // DilatedDnCNNSmall — symmetric dilations (1,2,4,8,4,2,1)
    });
    noteOnnx(state.onnxSession.executionProvider, state.onnxSession.precision);
    setStatus("ONNX denoiser model loaded");
  } catch (err) {
    console.error("Failed to load ONNX model:", err);
    setStatus("Failed to load denoiser model \u2014 check console for details");
    throw err;
  }
}
async function onNewFile(file) {
  setStatus(`Saving ${file.name}...`);
  try {
    const id = await saveFile(file);
    state.currentFileId = id;
  } catch (err) {
    console.error("Failed to save file:", err);
  }
  const buffer = await file.arrayBuffer();
  await loadPdf(new Uint8Array(buffer), file.name);
  refreshFileList();
}
async function onStoredFileSelected(stored) {
  state.currentFileId = stored.id;
  await loadPdf(stored.data, stored.name);
}
function resetPipelineState() {
  setInkSources(/* @__PURE__ */ new Map(), null);
  getTextureManager()?.setSuspended(false);
  for (const d of state.paletteDecompositions.values()) d.destroy();
  for (const d of state.thinnedDecompositions.values()) d.destroy();
  state.paletteDecompositions.clear();
  state.thinnedDecompositions.clear();
  state.inkLayers.clear();
  state.pathGraphs.clear();
  state.simplifiedPathGraphs.clear();
  state.undashedPathGraphs.clear();
  state.curveGraphs.clear();
  state.curvePathGraphs.clear();
  state.cropRects.clear();
  state.viewerLayer = "denoised";
  state.activeLayerIndex = -1;
  state.showFittedCurves = true;
  refreshGraphOverlay();
}
async function loadPdf(data, fileName) {
  resetPipelineState();
  state.pdfFileName = fileName;
  state.selectedPage = 0;
  state.rawImage = null;
  state.croppedRawImage = null;
  state.denoisedImage = null;
  state.paletteEntries = null;
  state.bwCounts = null;
  state.editablePalette = null;
  state.selectedPages = /* @__PURE__ */ new Set();
  state.coverPage = 1;
  state.denoisedPages = /* @__PURE__ */ new Set();
  state.pageSizes = [];
  state.pageLayout = null;
  state.activePageNumber = 0;
  clearPaletteEditor();
  setStatus(`Loading ${fileName}...`);
  try {
    state.pdfDoc = await loadPdfDocument(data, pdfjsLib);
    state.pdfPageCount = state.pdfDoc.numPages;
  } catch (err) {
    console.error("Failed to read PDF:", err);
    setStatus("Failed to read PDF");
    return;
  }
  state.pageSizes = await getPageSizes(state.pdfDoc);
  if (state.currentFileId) {
    try {
      const sel = await getPageSelection(state.currentFileId);
      if (sel) {
        state.selectedPages = new Set(sel.selectedPages);
        state.coverPage = sel.coverPage;
      }
      const denoisedNums = await getDenoisedPagesForFile(state.currentFileId);
      state.denoisedPages = new Set(denoisedNums);
      const savedPalette = await getPalette(state.currentFileId);
      if (savedPalette) {
        state.editablePalette = savedPalette;
        renderPaletteEditor(savedPalette);
      }
    } catch (err) {
      console.error("Failed to load saved state:", err);
    }
  }
  updateCoverThumbnail().then(() => refreshFileList()).catch(() => {
  });
  state.pageLabels = await getPageLabels(state.pdfDoc);
  if (state.pdfPageCount === 1) {
    state.selectedPages.add(1);
    showScreen("viewer");
    await enterInspection();
    return;
  }
  showScreen("viewer");
  const pageName = document.getElementById("viewerPageName");
  if (pageName) pageName.textContent = fileName;
  await populatePageGrid(
    state.pdfDoc,
    state.pdfPageCount,
    browserCanvasBackend,
    state.selectedPages,
    state.denoisedPages,
    state.pageLabels
  );
  updatePageGridState(state.selectedPages, state.denoisedPages);
  updateSelectionInfo(state.selectedPages.size, state.denoisedPages.size);
  updateContinueButton();
  if (state.selectedPages.size > 0) {
    await enterInspection();
  } else {
    setPagePickerMode(true);
  }
}
async function enterInspection() {
  if (!state.pdfDoc || state.selectedPages.size === 0) return;
  if (state.editablePalette) {
    renderPaletteEditor(state.editablePalette);
  }
  setPagePickerMode(false);
  showScreen("viewer");
  setStatus("Rendering pages...");
  const sorted = [...state.selectedPages].sort((a, b) => a - b);
  if (state.currentFileId) {
    try {
      const savedRects = await getCropRectsForFile(state.currentFileId);
      for (const sr of savedRects) {
        if (state.selectedPages.has(sr.pageNumber)) {
          state.cropRects.set(sr.pageNumber, {
            x: sr.x,
            y: sr.y,
            width: sr.width,
            height: sr.height
          });
        }
      }
    } catch {
    }
  }
  const crops = state.cropRects.size > 0 ? state.cropRects : void 0;
  const layout = computePageLayout(sorted, state.pageSizes, 200, crops);
  state.pageLayout = layout;
  await enterMultiPageView(
    layout,
    state.pdfDoc,
    browserCanvasBackend,
    state.currentFileId ?? "",
    state.denoisedPages,
    (pageNumber) => {
      state.denoisedPages.delete(pageNumber);
    }
  );
  if (sorted.length > 0) {
    onActivePageChanged(sorted[0]);
  }
  setStatus(`${sorted.length} page${sorted.length !== 1 ? "s" : ""} loaded`);
  refreshSidebar();
}
function onActivePageChanged(pageNumber) {
  state.selectedPage = pageNumber;
  state.activePageNumber = pageNumber;
  const pageName = state.pageLabels[pageNumber - 1] ?? `Page ${pageNumber}`;
  const nameEl = document.getElementById("viewerPageName");
  if (nameEl) nameEl.textContent = pageName;
  state.rawImage = null;
  state.croppedRawImage = null;
  state.denoisedImage = null;
  state.cropRect = null;
  loadActivePageState(pageNumber);
}
async function loadActivePageState(pageNumber) {
  if (!state.pdfDoc) return;
  const loadedDenoised = await tryLoadDenoisedImage(pageNumber);
  if (loadedDenoised) {
    state.denoisedImage = loadedDenoised;
    onDenoiseComplete();
    setStatus(`Page ${state.pageLabels[pageNumber - 1] ?? pageNumber} \u2014 denoised`);
  } else {
    showFreshPageControls();
    setDenoiseButtonEnabled(true);
    setStatus(`Page ${state.pageLabels[pageNumber - 1] ?? pageNumber}`);
  }
}
async function tryLoadDenoisedImage(pageNumber) {
  if (!state.currentFileId) return null;
  try {
    const stored = await getDenoisedImage(state.currentFileId, pageNumber);
    if (!stored) return null;
    return await pngBlobToRgbaImage(stored.pngBlob, stored.width, stored.height);
  } catch (err) {
    console.error("Failed to load denoised image:", err);
    return null;
  }
}
function onPageToggled(pageNumber) {
  if (state.selectedPages.has(pageNumber)) {
    state.selectedPages.delete(pageNumber);
  } else {
    state.selectedPages.add(pageNumber);
  }
  updatePageGridState(state.selectedPages, state.denoisedPages);
  updateSelectionInfo(state.selectedPages.size, state.denoisedPages.size);
  updateContinueButton();
  persistPageSelection();
}
function defaultCropRect(w, h) {
  const inset = 0.05;
  const x = Math.round(w * inset);
  const y = Math.round(h * inset);
  return { x, y, width: w - 2 * x, height: h - 2 * y };
}
async function loadOrInheritCropRect(imgW, imgH, pageNumber) {
  if (!state.currentFileId) return defaultCropRect(imgW, imgH);
  try {
    const saved = await getCropRect(state.currentFileId, pageNumber);
    if (saved) return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    const allRects = await getCropRectsForFile(state.currentFileId);
    if (allRects.length > 0) {
      const sorted = allRects.sort((a, b) => b.pageNumber - a.pageNumber);
      const inherited = sorted[0];
      if (inherited.x + inherited.width <= imgW && inherited.y + inherited.height <= imgH) {
        return { x: inherited.x, y: inherited.y, width: inherited.width, height: inherited.height };
      }
    }
  } catch (err) {
    console.error("Failed to load crop rect:", err);
  }
  return defaultCropRect(imgW, imgH);
}
function rgbaImageToDataUrl(image) {
  const canvas2 = document.createElement("canvas");
  canvas2.width = image.width;
  canvas2.height = image.height;
  const ctx2 = canvas2.getContext("2d");
  ctx2.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0
  );
  return canvas2.toDataURL("image/png");
}
async function updateCoverThumbnail() {
  if (!state.currentFileId || !state.pdfDoc) return;
  try {
    const thumb = await renderPdfThumbnail(state.pdfDoc, state.coverPage, browserCanvasBackend);
    const dataUrl = rgbaImageToDataUrl(thumb);
    await updateFile(state.currentFileId, { thumbnail: dataUrl });
  } catch (err) {
    console.error("Failed to update cover thumbnail:", err);
  }
}
async function persistPalette() {
  if (!state.currentFileId || !state.editablePalette) return;
  try {
    await savePalette(state.currentFileId, state.editablePalette);
  } catch (err) {
    console.error("Failed to save palette:", err);
  }
}
async function persistPageSelection() {
  if (!state.currentFileId) return;
  try {
    await savePageSelection({
      fileId: state.currentFileId,
      selectedPages: [...state.selectedPages],
      coverPage: state.coverPage
    });
  } catch (err) {
    console.error("Failed to save page selection:", err);
  }
}
async function runProjectPalette() {
  if (state.isPaletteExtracting) return;
  const layout = state.pageLayout;
  const pages = layout ? layout.pages.map((p) => p.pageNumber) : [...state.selectedPages];
  const tm = getTextureManager();
  const eligiblePages = pages.filter((p) => state.denoisedPages.has(p));
  if (eligiblePages.length === 0) {
    setStatus("No denoised pages found \u2014 denoise first, then extract palette");
    return;
  }
  state.isPaletteExtracting = true;
  setPaletteButtonsEnabled(false);
  updatePaletteProgress(0.01);
  try {
    state.editablePalette = null;
    const total = eligiblePages.length;
    const t02 = performance.now();
    const voxelGrids = [];
    const bwCountsList = [];
    for (let i = 0; i < total; i++) {
      const page = eligiblePages[i];
      setStatus(`Extracting palette: loading page ${i + 1} of ${total}\u2026`);
      await new Promise((r) => setTimeout(r, 0));
      let img = null;
      if (tm) {
        try {
          img = await tm.getFullImage(page);
        } catch {
        }
      }
      if (!img) img = await tryLoadDenoisedImage(page);
      if (!img) continue;
      const crop = state.cropRects.get(page);
      if (crop && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= img.width && crop.y + crop.height <= img.height) {
        img = cropRGBAImage(img, crop.x, crop.y, crop.width, crop.height);
      }
      const gpuCtx = await getGPUContext();
      setStatus(`Extracting palette: binning page ${i + 1} of ${total}\u2026`);
      const { grid, bw } = await buildVoxelGridGPU(gpuCtx.device, img);
      voxelGrids.push(grid);
      bwCountsList.push(bw);
      updatePaletteProgress((i + 1) / total * 0.9);
    }
    if (voxelGrids.length === 0) {
      setStatus("No denoised pages could be loaded \u2014 check console");
      return;
    }
    setStatus("Smoothing histogram and extracting palette\u2026");
    updatePaletteProgress(0.92);
    await new Promise((r) => setTimeout(r, 0));
    const mergedGrid = mergeVoxelGrids(voxelGrids);
    const entries = extractPaletteFromVoxels(mergedGrid);
    updatePaletteProgress(0.98);
    const mergedBW = mergeBWCounts(bwCountsList);
    state.editablePalette = createEditablePalette(entries, mergedBW);
    const t1 = performance.now();
    updatePaletteProgress(1);
    renderPaletteEditor(state.editablePalette);
    await persistPalette();
    setStatus(`Palette: ${state.editablePalette.inputs.length} colors from ${voxelGrids.length} pages (${(t1 - t02).toFixed(0)}ms)`);
  } catch (err) {
    console.error("Palette extraction failed:", err);
    setStatus("Palette extraction failed \u2014 try again (GPU may have been reset)");
  } finally {
    state.isPaletteExtracting = false;
    setPaletteButtonsEnabled(true);
    updatePaletteProgress(0);
  }
}
async function runApplyPalette() {
  beginStage("apply palette (decompose+cleanup)");
  const palette = state.editablePalette;
  if (!palette) {
    setStatus("Extract a palette first");
    return;
  }
  const layout = state.pageLayout;
  const pages = layout ? layout.pages.map((p) => p.pageNumber) : [...state.selectedPages];
  const tm = getTextureManager();
  const eligible = pages.filter((p) => state.denoisedPages.has(p));
  if (eligible.length === 0) {
    setStatus("No denoised pages found \u2014 denoise first, then apply palette");
    return;
  }
  const wasInkView = state.viewerLayer === "combined" || state.viewerLayer === "layer";
  const inkLayerIndex = state.activeLayerIndex;
  setInkSources(/* @__PURE__ */ new Map(), null);
  setStatus(`Decomposing palette across ${eligible.length} page(s)\u2026`);
  let decomposed = 0;
  for (let i = 0; i < eligible.length; i++) {
    const pageNumber = eligible[i];
    setStatus(`Palette decomposition: page ${i + 1} of ${eligible.length}\u2026`);
    await new Promise((r) => setTimeout(r, 0));
    try {
      let img = null;
      if (tm) {
        try {
          img = await tm.getFullImage(pageNumber);
        } catch {
        }
      }
      if (!img) img = await tryLoadDenoisedImage(pageNumber);
      if (!img) continue;
      const crop = state.cropRects.get(pageNumber);
      if (crop && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= img.width && crop.y + crop.height <= img.height) {
        img = cropRGBAImage(img, crop.x, crop.y, crop.width, crop.height);
      }
      const gpuDevice = (await getGPUContext()).device;
      state.paletteDecompositions.get(pageNumber)?.destroy();
      const rawDecomp = await decomposePalette(gpuDevice, img, palette);
      const cleaned1 = await cleanupPalette(gpuDevice, rawDecomp);
      rawDecomp.destroy();
      const decomp = await cleanupPalette(gpuDevice, cleaned1);
      cleaned1.destroy();
      state.paletteDecompositions.set(pageNumber, decomp);
      decomposed++;
    } catch (err) {
      console.error(`Palette decomposition failed for page ${pageNumber}:`, err);
    }
  }
  if (decomposed === 0) {
    setStatus("Palette decomposition failed \u2014 check console");
    return;
  }
  if (wasInkView) selectDecompositionView(inkLayerIndex);
  setStatus(`Decomposed palette into ${state.paletteDecompositions.get(eligible[0])?.layers.length ?? 0} layer(s) for ${decomposed} page(s)`);
  refreshSidebar();
}
async function runThinning() {
  beginStage("thin");
  if (state.isThinning) return;
  if (state.paletteDecompositions.size === 0) {
    setStatus("Apply palette first, then thin");
    return;
  }
  let gpuDevice = null;
  let thinOnCpu = false;
  try {
    const ctx2 = await getGPUContext();
    gpuDevice = ctx2.device;
    thinOnCpu = isSoftwareAdapter(ctx2.adapter);
    if (thinOnCpu) {
      console.log(`[thin] software adapter (${describeAdapter(ctx2.adapter)}) \u2192 CPU Guo-Hall`);
    }
  } catch (err) {
    setStatus("WebGPU unavailable \u2014 cannot thin");
    console.error("getGPUContext failed:", err);
    return;
  }
  state.isThinning = true;
  const pages = [...state.paletteDecompositions.keys()].sort((a, b) => a - b);
  setStatus(`Thinning ${pages.length} page(s)\u2026`);
  let thinned = 0;
  for (let i = 0; i < pages.length; i++) {
    const pageNumber = pages[i];
    setStatus(`Thinning: page ${i + 1} of ${pages.length}\u2026`);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const decomp = state.paletteDecompositions.get(pageNumber);
      state.thinnedDecompositions.get(pageNumber)?.destroy();
      const result = await thinDecompositionAuto(gpuDevice, decomp, { forceCpu: thinOnCpu });
      state.thinnedDecompositions.set(pageNumber, result);
      state.inkLayers.set(pageNumber, result.layers);
      thinned++;
    } catch (err) {
      console.error(`Thinning failed for page ${pageNumber}:`, err);
    }
  }
  state.isThinning = false;
  if (thinned === 0) {
    setStatus("Thinning failed \u2014 check console");
    return;
  }
  setStatus(`Thinned ${thinned} page(s)`);
  refreshSidebar();
  await runPathConnect(gpuDevice);
}
async function runPathConnect(gpuDevice) {
  beginStage("path connect");
  const pages = [...state.thinnedDecompositions.keys()].sort((a, b) => a - b);
  if (pages.length === 0) return;
  setStatus("Connecting paths\u2026");
  state.pathGraphs.clear();
  for (const pageNumber of pages) {
    const decomp = state.thinnedDecompositions.get(pageNumber);
    try {
      const graph = await connectPaths(gpuDevice, decomp);
      state.pathGraphs.set(pageNumber, graph);
    } catch (err) {
      console.error(`connectPaths failed for page ${pageNumber}:`, err);
    }
    decomp.destroy();
    state.thinnedDecompositions.delete(pageNumber);
  }
  state.simplifiedPathGraphs.clear();
  state.undashedPathGraphs.clear();
  state.curveGraphs.clear();
  state.curvePathGraphs.clear();
  refreshGraphOverlay();
  refreshSidebar();
  const totalV = [...state.pathGraphs.values()].reduce((s, g) => s + g.vertices.length, 0);
  const totalE = [...state.pathGraphs.values()].reduce((s, g) => s + g.edges.length, 0);
  setStatus(`Paths connected: ${totalV} vertices, ${totalE} edges`);
}
function refreshGraphOverlay() {
  const layout = state.pageLayout;
  if (!layout || !state.showFittedCurves || state.curvePathGraphs.size === 0) {
    updateGraphOverlay([], -1);
    setGraphOverlayVisible(false);
    return;
  }
  const overlayPages = [];
  for (const page of layout.pages) {
    const graph = state.curvePathGraphs.get(page.pageNumber);
    if (!graph) continue;
    const imgOriginX = (layout.maxWidth - page.width) / 2;
    const imgOriginY = page.yOffset;
    const layerColors = (state.inkLayers.get(page.pageNumber) ?? []).map((l) => l.outputRgb);
    overlayPages.push({ graph, imgOriginX, imgOriginY, layerColors });
  }
  try {
    updateGraphOverlay(overlayPages, state.activeLayerIndex);
    setGraphOverlayVisible(overlayPages.length > 0);
  } catch (err) {
    console.error("Fitted-curve overlay upload failed:", err);
    setGraphOverlayVisible(false);
  }
}
function setShowFittedCurves(show) {
  state.showFittedCurves = show;
  const cb = document.getElementById("showFittedCurves");
  if (cb) cb.checked = show;
  refreshGraphOverlay();
}
function initCursorReadout() {
  const viewerContainer = document.getElementById("viewerContainer");
  if (!viewerContainer) return;
  const clear = () => {
    const posEl = document.getElementById("viewerCursorPos");
    const sepEl = document.getElementById("cursorPosSep");
    if (posEl) posEl.textContent = "";
    if (sepEl) sepEl.style.display = "none";
  };
  viewerContainer.addEventListener("mouseleave", clear);
  viewerContainer.addEventListener("mousemove", (e) => {
    const posEl = document.getElementById("viewerCursorPos");
    const sepEl = document.getElementById("cursorPosSep");
    if (!posEl || !sepEl) return;
    const layout = state.pageLayout;
    if (!layout) {
      clear();
      return;
    }
    const rect = viewerContainer.getBoundingClientRect();
    const virtualX = (e.clientX - rect.left - state.panX) / state.zoom;
    const virtualY = (e.clientY - rect.top - state.panY) / state.zoom;
    let localX = -1, localY = -1;
    for (const page of layout.pages) {
      const pl = (layout.maxWidth - page.width) / 2;
      if (virtualX >= pl && virtualX < pl + page.width && virtualY >= page.yOffset && virtualY < page.yOffset + page.height) {
        localX = virtualX - pl;
        localY = virtualY - page.yOffset;
        break;
      }
    }
    if (localX < 0) {
      clear();
      return;
    }
    sepEl.style.display = "";
    posEl.textContent = `${Math.round(localX)}, ${Math.round(localY)} px`;
  });
}
async function runPathSimplify() {
  beginStage("simplify + despur");
  if (state.pathGraphs.size === 0) {
    setStatus("Run Thin first to generate path graphs");
    return;
  }
  setStatus("Simplifying paths\u2026");
  state.simplifiedPathGraphs.clear();
  for (const [pageNumber, graph] of state.pathGraphs) {
    const simplified = simplifyPathGraph(graph, DEFAULT_SIMPLIFY_TOL);
    const decomp = state.paletteDecompositions.get(pageNumber);
    const ink = decomp ? await readInkProbe((await getGPUContext()).device, decomp) : void 0;
    const marks = [];
    state.simplifiedPathGraphs.set(pageNumber, removeSpurs(simplified, DEFAULT_SPUR_MAX, ink, marks));
    state.strokeMarks.set(pageNumber, marks);
  }
  const simplifiedOption = document.getElementById("simplifiedOverlayOption");
  if (simplifiedOption) simplifiedOption.style.display = "";
  state.undashedPathGraphs.clear();
  state.curveGraphs.clear();
  state.curvePathGraphs.clear();
  updateExportButtons();
  const totalV = [...state.simplifiedPathGraphs.values()].reduce((s, g) => s + g.vertices.length, 0);
  const totalE = [...state.simplifiedPathGraphs.values()].reduce((s, g) => s + g.edges.length, 0);
  setStatus(`Simplified: ${totalV} vertices, ${totalE} edges (tolerance ${DEFAULT_SIMPLIFY_TOL}px)`);
}
function runUndash() {
  beginStage("undash");
  if (state.simplifiedPathGraphs.size === 0) {
    setStatus("Run Simplify first");
    return;
  }
  setStatus("Undashing\u2026");
  state.undashedPathGraphs.clear();
  state.curveGraphs.clear();
  state.curvePathGraphs.clear();
  updateExportButtons();
  for (const [pageNumber, graph] of state.simplifiedPathGraphs) {
    const undashed = undashPaths(graph, DEFAULT_UNDASH_MAX_GAP, DEFAULT_UNDASH_MAX_ANGLE);
    state.undashedPathGraphs.set(
      pageNumber,
      simplifyPathGraph(undashed, DEFAULT_SIMPLIFY_TOL)
    );
  }
  const totalV = [...state.undashedPathGraphs.values()].reduce((s, g) => s + g.vertices.length, 0);
  const totalE = [...state.undashedPathGraphs.values()].reduce((s, g) => s + g.edges.length, 0);
  setStatus(`Undashed: ${totalV} vertices, ${totalE} edges (gap \u2264${DEFAULT_UNDASH_MAX_GAP}px, angle \u2264${DEFAULT_UNDASH_MAX_ANGLE}\xB0)`);
}
async function runCurveFit() {
  beginStage("curve fit");
  if (state.undashedPathGraphs.size === 0) {
    setStatus("Run Undash first");
    return;
  }
  const { device: gpuDevice } = await getGPUContext();
  setStatus("Fitting curves\u2026");
  state.curveGraphs.clear();
  state.curvePathGraphs.clear();
  const opts = { ...DEFAULT_FIT_OPTS };
  const pages = [...state.undashedPathGraphs.entries()];
  for (let pi = 0; pi < pages.length; pi++) {
    const [pageNumber, graph] = pages[pi];
    const decomp = state.paletteDecompositions.get(pageNumber);
    if (!decomp) continue;
    const pagePrefix = pages.length > 1 ? `p${pageNumber} ` : "";
    const validationOut = {};
    const curveGraph = await fitCurves(gpuDevice, graph, decomp, opts, (_frac, label) => {
      setStatus(`${pagePrefix}${label}`);
    }, validationOut);
    appendStrokeMarks(curveGraph, state.strokeMarks.get(pageNumber) ?? []);
    state.curveGraphs.set(pageNumber, curveGraph);
    state.curvePathGraphs.set(pageNumber, curveGraphToPathGraph(curveGraph, DEFAULT_FIT_OPTS.arcStep));
    const v = validationOut.result;
    const summary = [
      `chains: ${v.totalChains} total, ${v.absorbedChains} absorbed, ${v.droppedChains} dropped`,
      `coverage: mean ${v.meanCoverageError.toFixed(2)} px, max ${v.maxCoverageError.toFixed(2)} px (${v.coveredVertices} verts)`,
      `backward segs: ${v.backwardSegments}`,
      `junction gaps: ${v.disconnectedJunctions}`
    ].join(" | ");
    if (v.droppedChains > 0 || v.backwardSegments > 0 || v.disconnectedJunctions > 0) {
      console.warn(`[fit validation] ${pagePrefix}${summary}`);
      for (const w of v.warnings) console.warn(`  [${w.type}] ${w.message}`, w.x != null ? `@ (${w.x?.toFixed(1)}, ${w.y?.toFixed(1)})` : "");
    } else {
      console.log(`[fit validation] ${pagePrefix}${summary}`);
    }
  }
  refreshSidebar();
  setShowFittedCurves(true);
  const totalSegs = [...state.curveGraphs.values()].reduce((s, g) => s + g.segments.length, 0);
  setStatus(`Fitted curves: ${totalSegs} segments`);
}
var EXPORT_DPI = 200;
function triggerDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e4);
}
function refreshDiagnostics() {
  const summary = document.getElementById("diagnosticsSummary");
  const details = document.getElementById("diagnosticsDetails");
  const text = document.getElementById("diagnosticsText");
  const copyBtn = document.getElementById("copyDiagnosticsBtn");
  const saveBtn = document.getElementById("saveDiagnosticsBtn");
  const r = getReport();
  if (r.stages.length === 0) return;
  lastDiagnosticsText = formatReport();
  if (text) text.textContent = lastDiagnosticsText;
  if (details) details.style.display = "";
  if (copyBtn) copyBtn.disabled = false;
  if (saveBtn) saveBtn.disabled = false;
  const pct = (r.blockedFraction * 100).toFixed(0);
  const worst = (Math.max(r.longTaskMaxMs, r.worstFrameGapMs) / 1e3).toFixed(1);
  if (summary) {
    summary.textContent = `${(r.totalMs / 1e3).toFixed(0)}s total, unresponsive for ${pct}% of it. Longest single freeze ${worst}s.`;
  }
  console.log("\n" + lastDiagnosticsText);
}
var lastDiagnosticsText = "";
function updateExportButtons() {
  const canExport = state.curveGraphs.size > 0;
  for (const id of ["exportSvgBtn", "exportDxfBtn", "exportOverlayPdfBtn"]) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !canExport;
  }
}
function exportLayersForPage(pageNumber, layerCount) {
  const layers = state.inkLayers.get(pageNumber) ?? state.paletteDecompositions.get(pageNumber)?.layers;
  if (layers) {
    return layers.map((l, i) => ({ name: `Ink ${i + 1}`, rgb: l.outputRgb }));
  }
  return Array.from({ length: layerCount }, (_, i) => ({
    name: `Layer ${i + 1}`,
    rgb: [0, 0, 0]
  }));
}
async function runExport(format) {
  if (state.curveGraphs.size === 0) {
    setStatus("Run Vectorize first \u2014 nothing to export yet");
    return;
  }
  const base = (state.pdfFileName || "cleanplans").replace(/\.pdf$/i, "");
  const pages = [...state.curveGraphs.keys()].sort((a, b) => a - b);
  const opts = { dpi: EXPORT_DPI };
  let exported = 0;
  for (const pageNumber of pages) {
    const graph = state.curveGraphs.get(pageNumber);
    const layers = exportLayersForPage(pageNumber, graph.layerCount);
    const content = format === "svg" ? curveGraphToSvg(graph, { ...opts, layers }) : curveGraphToDxf(graph, { ...opts, layers });
    const mime = format === "svg" ? "image/svg+xml" : "application/dxf";
    triggerDownload(`${base}-page${pageNumber}.${format}`, content, mime);
    exported++;
    if (pages.length > 1) await new Promise((r) => setTimeout(r, 300));
  }
  setStatus(`Exported ${exported} ${format.toUpperCase()} file${exported !== 1 ? "s" : ""}`);
}
async function runCleanExport(format) {
  if (state.paletteDecompositions.size === 0) {
    setStatus("Apply a palette first \u2014 no cleaned pages yet");
    return;
  }
  let gpuDevice;
  try {
    gpuDevice = (await getGPUContext()).device;
  } catch (err) {
    setStatus("WebGPU unavailable \u2014 cannot read cleaned pages");
    console.error("getGPUContext failed:", err);
    return;
  }
  const base = (state.pdfFileName || "cleanplans").replace(/\.pdf$/i, "");
  const pages = [...state.paletteDecompositions.keys()].sort((a, b) => a - b);
  try {
    if (format === "png") {
      let n = 0;
      for (const pageNumber of pages) {
        setStatus(`Encoding clean PNG for page ${pageNumber}\u2026`);
        const img = await readAllLayersAsRGBA(gpuDevice, state.paletteDecompositions.get(pageNumber));
        triggerDownload(`${base}-page${pageNumber}-clean.png`, await encodeCleanPng(img), "image/png");
        n++;
        if (pages.length > 1) await new Promise((r) => setTimeout(r, 300));
      }
      setStatus(`Exported ${n} clean PNG${n !== 1 ? "s" : ""}`);
    } else {
      const rasterPages = [];
      for (const pageNumber of pages) {
        setStatus(`Reading clean page ${pageNumber}\u2026`);
        rasterPages.push({
          image: await readAllLayersAsRGBA(gpuDevice, state.paletteDecompositions.get(pageNumber)),
          dpi: EXPORT_DPI
        });
      }
      setStatus("Encoding clean PDF\u2026");
      triggerDownload(`${base}-clean.pdf`, await encodeCleanPdf(rasterPages), "application/pdf");
      setStatus(`Exported clean PDF (${rasterPages.length} page${rasterPages.length !== 1 ? "s" : ""})`);
    }
  } catch (err) {
    console.error("clean export failed:", err);
    setStatus("Clean export failed \u2014 check console");
  }
}
async function runOverlayExport() {
  if (state.curveGraphs.size === 0) {
    setStatus("Run Vectorize first \u2014 nothing to overlay yet");
    return;
  }
  let gpuDevice;
  try {
    gpuDevice = (await getGPUContext()).device;
  } catch (err) {
    setStatus("WebGPU unavailable \u2014 cannot read cleaned pages");
    console.error("getGPUContext failed:", err);
    return;
  }
  const base = (state.pdfFileName || "cleanplans").replace(/\.pdf$/i, "");
  const pages = [...state.curveGraphs.keys()].sort((a, b) => a - b);
  try {
    const rasterPages = [];
    const skipped = [];
    for (const pageNumber of pages) {
      const decomp = state.paletteDecompositions.get(pageNumber);
      if (!decomp) {
        skipped.push(pageNumber);
        continue;
      }
      setStatus(`Reading clean page ${pageNumber}\u2026`);
      const graph = state.curveGraphs.get(pageNumber);
      rasterPages.push({
        image: await readAllLayersAsRGBA(gpuDevice, decomp),
        dpi: EXPORT_DPI,
        overlay: curveGraphToPdfOverlay(graph, {
          dpi: EXPORT_DPI,
          layers: exportLayersForPage(pageNumber, graph.layerCount)
        })
      });
    }
    if (rasterPages.length === 0) {
      setStatus("No page has both a cleaned raster and a fit \u2014 nothing to overlay");
      return;
    }
    setStatus("Encoding overlay PDF\u2026");
    triggerDownload(`${base}-overlay.pdf`, await encodeCleanPdf(rasterPages), "application/pdf");
    const n = rasterPages.length;
    setStatus(
      `Exported overlay PDF (${n} page${n !== 1 ? "s" : ""})` + (skipped.length ? ` \u2014 skipped ${skipped.join(", ")}: no cleaned raster` : "")
    );
  } catch (err) {
    console.error("overlay export failed:", err);
    setStatus("Overlay export failed \u2014 check console");
  }
}
async function runVectorize() {
  if (state.isVectorizing) return;
  if (!state.editablePalette) {
    setStatus("Extract a palette first");
    return;
  }
  state.isVectorizing = true;
  const btn = document.getElementById("vectorizeBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Vectorizing\u2026";
  }
  await startProfile();
  note(`vectorize ${state.selectedPages.size || 1} page(s) at ${EXPORT_DPI} dpi`);
  try {
    await runApplyPalette();
    if (state.paletteDecompositions.size === 0) return;
    await runThinning();
    if (state.pathGraphs.size === 0) return;
    await runPathSimplify();
    if (state.simplifiedPathGraphs.size === 0) return;
    runUndash();
    if (state.undashedPathGraphs.size === 0) return;
    await runCurveFit();
    await selectCombinedLayer();
  } finally {
    state.isVectorizing = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Vectorize";
    }
    stopProfile();
    refreshDiagnostics();
  }
}
function setViewLayer(mode) {
  setInkSources(/* @__PURE__ */ new Map(), null);
  const tm = getTextureManager();
  tm?.setSuspended(false);
  tm?.setViewMode(mode);
  state.viewerLayer = mode;
  state.activeLayerIndex = -1;
  refreshSidebar();
  requestRedraw();
  if (state.pathGraphs.size > 0) refreshGraphOverlay();
}
function selectDecompositionView(layerIndex) {
  const combined = layerIndex < 0;
  state.viewerLayer = combined ? "combined" : "layer";
  state.activeLayerIndex = combined ? -1 : layerIndex;
  const sources = /* @__PURE__ */ new Map();
  let colors = [];
  for (const [pageNumber, decomp] of state.paletteDecompositions) {
    if (decomp.cpuWords) continue;
    if (!combined && layerIndex >= decomp.layers.length) continue;
    if (colors.length === 0) colors = decomp.layers.map((l) => l.outputRgb);
    sources.set(pageNumber, {
      buffer: decomp.buffer,
      width: decomp.width,
      height: decomp.height,
      rowStride: decomp.rowStride,
      layerCount: decomp.layers.length,
      activeLayer: combined ? -1 : layerIndex
    });
  }
  setInkSources(sources, { colors, background: [255, 255, 255] });
  getTextureManager()?.setSuspended(sources.size > 0);
  refreshSidebar();
  requestRedraw();
  if (state.pathGraphs.size > 0) refreshGraphOverlay();
}
var selectLayer = (layerIndex) => selectDecompositionView(layerIndex);
var selectCombinedLayer = () => selectDecompositionView(-1);
function refreshSidebar() {
  refreshSteps();
  const paletteHeader = document.getElementById("paletteHeader");
  if (paletteHeader) paletteHeader.style.display = state.editablePalette ? "" : "none";
  const radios = document.querySelectorAll(
    '#viewRadioList input[name="viewLayer"]'
  );
  for (const radio of radios) {
    const val = radio.value;
    radio.checked = val === "denoised" && state.viewerLayer === "denoised" || val === "raw" && state.viewerLayer === "raw";
  }
  const container2 = document.getElementById("layerRadioEntries");
  if (!container2) return;
  container2.innerHTML = "";
  const anyDecomp = [...state.paletteDecompositions.values()][0];
  if (anyDecomp && anyDecomp.layers.length > 0) {
    const item = (value, checked, swatches, text) => {
      const label = document.createElement("label");
      label.className = "view-radio-item";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "viewLayer";
      input.value = value;
      input.checked = checked;
      const name = document.createElement("span");
      name.textContent = text;
      label.append(input, swatches, name);
      container2.appendChild(label);
    };
    const swatchRow = document.createElement("span");
    swatchRow.className = "view-swatch-row";
    for (const layer of anyDecomp.layers) {
      const [r, g, b] = layer.outputRgb;
      const s = document.createElement("span");
      s.className = "view-swatch view-swatch-mini";
      s.style.background = `rgb(${r},${g},${b})`;
      swatchRow.appendChild(s);
    }
    item("combined", state.viewerLayer === "combined", swatchRow, "Cleaned page");
    for (let i = 0; i < anyDecomp.layers.length; i++) {
      const [r, g, b] = anyDecomp.layers[i].outputRgb;
      const swatch = document.createElement("span");
      swatch.className = "view-swatch";
      swatch.style.background = `rgb(${r},${g},${b})`;
      item(
        `layer:${i}`,
        state.viewerLayer === "layer" && state.activeLayerIndex === i,
        swatch,
        `Ink ${i + 1}`
      );
    }
  }
  const fitRow = document.getElementById("fittedOverlayRow");
  if (fitRow) fitRow.style.display = state.curvePathGraphs.size > 0 ? "" : "none";
  const showFitCb = document.getElementById("showFittedCurves");
  if (showFitCb) showFitCb.checked = state.showFittedCurves;
  updateExportButtons();
}
function refreshSteps() {
  const pages = [...state.selectedPages].sort((a, b) => a - b);
  let pagesValue = "";
  if (pages.length === 1) pagesValue = `page ${pages[0]}`;
  else if (pages.length > 1) {
    const contiguous = pages[pages.length - 1] - pages[0] === pages.length - 1;
    pagesValue = contiguous ? `pages ${pages[0]}\u2013${pages[pages.length - 1]}` : `${pages.length} pages`;
  }
  const denoised = pages.filter((p) => state.denoisedPages.has(p)).length;
  const denoiseValue = pages.length > 0 && denoised === pages.length ? denoised === 1 ? "1 page" : `${denoised} pages` : "";
  const crop = state.cropRects.get(state.activePageNumber);
  const cropValue = crop && crop.width > 0 && crop.height > 0 ? `${(crop.width / 200).toFixed(1)}\u2033 \xD7 ${(crop.height / 200).toFixed(1)}\u2033` : "";
  const decomp = [...state.paletteDecompositions.values()][0];
  const inks = decomp?.layers.length ?? 0;
  const paletteValue = inks > 0 ? inks === 1 ? "1 ink" : `${inks} inks` : "";
  updateSteps({
    stepPages: pagesValue,
    stepDenoise: denoiseValue,
    stepCrop: cropValue,
    stepPalette: paletteValue
  });
}
function showCropSidebar(visible) {
  for (const id of ["processSection", "vectorSection", "exportSection"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = visible ? "none" : "";
  }
  const cropSection = document.getElementById("cropModeSection");
  if (cropSection) cropSection.style.display = visible ? "" : "none";
}
function updateCropSizeDisplay() {
  const el = document.getElementById("cropSizeDisplay");
  if (!el) return;
  const crop = state.cropRects.get(state.activePageNumber);
  if (!crop) {
    el.textContent = "";
    return;
  }
  const wInches = crop.width / 200;
  const hInches = crop.height / 200;
  const isLandscape = wInches >= hInches;
  let text = `${wInches.toFixed(1)}" \xD7 ${hInches.toFixed(1)}"`;
  text += isLandscape ? " (landscape)" : " (portrait)";
  const w = Math.max(wInches, hInches);
  const h = Math.min(wInches, hInches);
  if (Math.abs(w - 30) < 0.5 && Math.abs(h - 20) < 0.5) {
    text += "\n30\xD720 \u2014 standard foam board";
  } else {
    text += '\nCommon: 30"\xD720" foam board';
  }
  el.style.whiteSpace = "pre-line";
  el.textContent = text;
}
function recomputeLayout(applyCrops) {
  const sorted = [...state.selectedPages].sort((a, b) => a - b);
  const crops = applyCrops && state.cropRects.size > 0 ? state.cropRects : void 0;
  const layout = computePageLayout(sorted, state.pageSizes, 200, crops);
  updateLayout(layout);
}
async function enterCropMode() {
  const layout = state.pageLayout;
  if (!layout || layout.pages.length === 0) return;
  state.cropMode = true;
  const sorted = [...state.selectedPages].sort((a, b) => a - b);
  const fullLayout = computePageLayout(sorted, state.pageSizes, 200);
  for (const page of fullLayout.pages) {
    if (state.cropRects.has(page.pageNumber)) continue;
    const rect = await loadOrInheritCropRect(page.fullWidth, page.fullHeight, page.pageNumber);
    state.cropRects.set(page.pageNumber, rect);
  }
  updateLayout(fullLayout);
  showCropSidebar(true);
  setCropEnabled(true);
  updateCropSizeDisplay();
  requestRedraw();
  setStatus("Adjust crop rectangles, then click Done Cropping");
}
function exitCropMode() {
  state.cropMode = false;
  setCropEnabled(false);
  showCropSidebar(false);
  recomputeLayout(true);
  requestRedraw();
  setStatus("Crop applied");
}
function persistAllCropRects() {
  if (!state.currentFileId) return;
  for (const [pageNum, rect] of state.cropRects) {
    saveCropRect({
      fileId: state.currentFileId,
      pageNumber: pageNum,
      ...rect
    }).catch(() => {
    });
  }
}
async function runAutoCropAll() {
  const tm = getTextureManager();
  if (!tm) return;
  const layout = state.pageLayout;
  if (!layout) return;
  setStatus("Auto-cropping all pages...");
  const pageInputs = [];
  let thumbDpi = 50;
  for (const page of layout.pages) {
    setStatus(`Loading page ${page.pageNumber} thumbnail...`);
    const { image, dpi } = await tm.getThumbnailImage(page.pageNumber);
    thumbDpi = dpi;
    const bgColor = findMajorityColor(image);
    pageInputs.push({ image, bgColor });
  }
  const scale = 200 / thumbDpi;
  const targetWEl = document.getElementById("cropTargetWidth");
  const targetHEl = document.getElementById("cropTargetHeight");
  const targetW = parseFloat(targetWEl?.value ?? "30") || 30;
  const targetH = parseFloat(targetHEl?.value ?? "20") || 20;
  let gpuMasks = null;
  try {
    const ctx2 = await getGPUContext();
    const gpuDevice = ctx2.device;
    const masks = [];
    for (let i = 0; i < pageInputs.length; i++) {
      setStatus(`Building content mask (GPU) for page ${layout.pages[i].pageNumber}...`);
      const { image, bgColor } = pageInputs[i];
      const bgOklab = srgbToOklab(bgColor[0], bgColor[1], bgColor[2]);
      masks.push(await buildContentMaskGPU(gpuDevice, image, bgOklab, BG_THRESHOLD));
    }
    gpuMasks = masks;
  } catch (_e) {
  }
  if (state.cropLocked) {
    setStatus("Computing optimal crop across all pages...");
    const result = gpuMasks !== null ? computeAutoCropFromMasks(gpuMasks, targetW, targetH, thumbDpi) : computeAutoCropMultiPage(pageInputs, targetW, targetH, thumbDpi);
    console.log(`[autocrop] multi-page: rect=${result.rect.x},${result.rect.y} ${result.rect.width}x${result.rect.height}, orient=${result.orientation}, bbox=${result.contentBBox.x},${result.contentBBox.y} ${result.contentBBox.width}x${result.contentBBox.height}`);
    const scaledRect = {
      x: Math.round(result.rect.x * scale),
      y: Math.round(result.rect.y * scale),
      width: Math.round(result.rect.width * scale),
      height: Math.round(result.rect.height * scale)
    };
    for (const page of layout.pages) {
      state.cropRects.set(page.pageNumber, { ...scaledRect });
    }
  } else {
    for (let i = 0; i < layout.pages.length; i++) {
      const page = layout.pages[i];
      setStatus(`Auto-cropping page ${page.pageNumber}...`);
      const input = pageInputs[i];
      const result = gpuMasks !== null ? computeAutoCropFromMasks([gpuMasks[i]], targetW, targetH, thumbDpi) : computeAutoCrop(input.image, input.bgColor, targetW, targetH, thumbDpi);
      console.log(`[autocrop] page ${page.pageNumber}: img=${input.image.width}x${input.image.height} @${thumbDpi}dpi, bg=[${input.bgColor}], rect=${result.rect.x},${result.rect.y} ${result.rect.width}x${result.rect.height}, orient=${result.orientation}, bbox=${result.contentBBox.x},${result.contentBBox.y} ${result.contentBBox.width}x${result.contentBBox.height}`);
      const scaledRect = {
        x: Math.round(result.rect.x * scale),
        y: Math.round(result.rect.y * scale),
        width: Math.round(result.rect.width * scale),
        height: Math.round(result.rect.height * scale)
      };
      state.cropRects.set(page.pageNumber, scaledRect);
    }
  }
  persistAllCropRects();
  if (!state.cropMode) {
    state.cropMode = true;
    showCropSidebar(true);
    setCropEnabled(true);
  }
  updateCropSizeDisplay();
  requestRedraw();
  setStatus(`Auto-cropped ${layout.pages.length} pages`);
}
function isGPUDeviceLoss(err) {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  const msg = String(err);
  return msg.includes("valid external Instance") || msg.includes("device lost") || msg.includes("Device is lost");
}
async function runDenoise() {
  if (state.isDenoising) return;
  const layout = state.pageLayout;
  if (!layout || layout.pages.length === 0) return;
  const tm = getTextureManager();
  if (!tm) return;
  try {
    await ensureOnnxSession();
  } catch {
    return;
  }
  state.isDenoising = true;
  setDenoiseButtonEnabled(false);
  const pages = layout.pages;
  const total = pages.length;
  const failed = [];
  await startProfile();
  note(`denoise ${total} page(s)`);
  beginStage("denoise");
  try {
    const ONNX_REFRESH_PAGES = 5;
    for (let idx = 0; idx < pages.length; idx++) {
      if (idx > 0 && idx % ONNX_REFRESH_PAGES === 0) {
        console.log(`Refreshing ONNX session after page ${idx} to release GPU memory\u2026`);
        state.onnxSession?.dispose();
        state.onnxSession = null;
        try {
          await ensureOnnxSession();
        } catch {
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 0));
      const page = pages[idx];
      const pageNumber = page.pageNumber;
      const label = state.pageLabels[pageNumber - 1] ?? `Page ${pageNumber}`;
      setStatus(`Denoising ${label} (${idx + 1}/${total})...`);
      const fullRawImage = await tm.getFullRawImage(pageNumber);
      let denoised;
      let pageOk = false;
      for (let attempt = 0; attempt < 2 && !pageOk; attempt++) {
        try {
          if (!state.onnxSession) {
            try {
              await ensureOnnxSession();
            } catch {
              failed.push(pageNumber);
              break;
            }
          }
          denoised = await denoise(
            fullRawImage,
            state.onnxSession,
            void 0,
            (progress) => {
              const overall = (idx + progress) / total;
              updateDenoiseProgress(overall);
            }
          );
          pageOk = true;
        } catch (err) {
          if (isGPUDeviceLoss(err) && attempt === 0) {
            console.warn(`GPU device loss on page ${pageNumber}, recreating ONNX session\u2026`);
            state.onnxSession?.dispose();
            state.onnxSession = null;
            continue;
          }
          console.error(`Denoise failed for page ${pageNumber}:`, err);
          failed.push(pageNumber);
          break;
        }
      }
      if (!pageOk) continue;
      const denoisedBlob = await rgbaImageToPngBlob(denoised);
      tm.updateDenoised(pageNumber, denoised, denoisedBlob);
      await saveDenoisedImage(
        state.currentFileId,
        pageNumber,
        denoisedBlob,
        denoised.width,
        denoised.height
      );
      state.denoisedPages.add(pageNumber);
    }
    onDenoiseComplete();
    refreshSidebar();
    if (failed.length === 0) {
      setStatus(`Denoised ${total} page${total !== 1 ? "s" : ""}`);
    } else {
      setStatus(`Denoised ${total - failed.length}/${total} pages \u2014 ${failed.length} failed (see console)`);
    }
  } catch (err) {
    console.error("Denoise failed:", err);
    setStatus("Denoise failed \u2014 check console");
  } finally {
    state.isDenoising = false;
    setDenoiseButtonEnabled(true);
    stopProfile();
    refreshDiagnostics();
  }
}
function init() {
  initUpload({ onNewFile, onStoredFileSelected });
  const pageSelectCb = {
    onPageToggled
  };
  attachPageGridClickHandler(pageSelectCb);
  const selectPagesBtn = document.getElementById("selectPagesBtn");
  if (selectPagesBtn) {
    selectPagesBtn.addEventListener("click", () => {
      if (!document.getElementById("viewerScreen")?.classList.contains("page-picker-active")) {
        setPagePickerMode(true);
      }
    });
  }
  const continueToViewBtn = document.getElementById("continueToViewBtn");
  if (continueToViewBtn) {
    continueToViewBtn.addEventListener("click", async () => {
      if (state.selectedPages.size > 0) {
        await enterInspection();
      }
    });
  }
  const viewRadioList = document.getElementById("viewRadioList");
  if (viewRadioList) {
    viewRadioList.addEventListener("change", async (e) => {
      const input = e.target;
      if (input.type !== "radio" || input.name !== "viewLayer") return;
      const val = input.value;
      if (document.getElementById("viewerScreen")?.classList.contains("page-picker-active")) {
        if (state.selectedPages.size === 0) return;
        await enterInspection();
      }
      if (val === "raw" || val === "denoised") {
        setViewLayer(val);
      } else if (val.startsWith("layer:")) {
        selectLayer(parseInt(val.slice(6), 10));
      } else if (val === "combined") {
        selectCombinedLayer();
      }
    });
  }
  const viewerPaletteBtn = document.getElementById("viewerExtractPaletteBtn");
  if (viewerPaletteBtn) {
    viewerPaletteBtn.addEventListener("click", () => runProjectPalette());
  }
  const vectorizeBtn = document.getElementById("vectorizeBtn");
  if (vectorizeBtn) {
    vectorizeBtn.addEventListener("click", () => {
      void runVectorize();
    });
  }
  const exportSvgBtn = document.getElementById("exportSvgBtn");
  if (exportSvgBtn) exportSvgBtn.addEventListener("click", () => {
    void runExport("svg");
  });
  const exportDxfBtn = document.getElementById("exportDxfBtn");
  if (exportDxfBtn) exportDxfBtn.addEventListener("click", () => {
    void runExport("dxf");
  });
  const applyPaletteBtn = document.getElementById("applyPaletteBtn");
  if (applyPaletteBtn) {
    applyPaletteBtn.addEventListener("click", () => {
      void (async () => {
        const btn = applyPaletteBtn;
        btn.disabled = true;
        try {
          await runApplyPalette();
        } finally {
          btn.disabled = false;
        }
      })();
    });
  }
  const exportCleanPngBtn = document.getElementById("exportCleanPngBtn");
  if (exportCleanPngBtn) exportCleanPngBtn.addEventListener("click", () => {
    void runCleanExport("png");
  });
  const exportCleanPdfBtn = document.getElementById("exportCleanPdfBtn");
  if (exportCleanPdfBtn) exportCleanPdfBtn.addEventListener("click", () => {
    void runCleanExport("pdf");
  });
  const exportOverlayPdfBtn = document.getElementById("exportOverlayPdfBtn");
  if (exportOverlayPdfBtn) exportOverlayPdfBtn.addEventListener("click", () => {
    void runOverlayExport();
  });
  const copyDiagnosticsBtn = document.getElementById("copyDiagnosticsBtn");
  copyDiagnosticsBtn?.addEventListener("click", async () => {
    if (!lastDiagnosticsText) return;
    try {
      await navigator.clipboard.writeText(lastDiagnosticsText);
      copyDiagnosticsBtn.textContent = "Copied";
    } catch {
      const pre = document.getElementById("diagnosticsText");
      const details = document.getElementById("diagnosticsDetails");
      if (details) details.open = true;
      if (pre) {
        const range = document.createRange();
        range.selectNodeContents(pre);
        const sel = globalThis.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      copyDiagnosticsBtn.textContent = "Select + copy";
    }
    setTimeout(() => {
      copyDiagnosticsBtn.textContent = "Copy";
    }, 2500);
  });
  const saveDiagnosticsBtn = document.getElementById("saveDiagnosticsBtn");
  saveDiagnosticsBtn?.addEventListener("click", () => {
    if (!lastDiagnosticsText) return;
    triggerDownload("cleanplans-diagnostics.txt", lastDiagnosticsText, "text/plain");
  });
  const showFitCb = document.getElementById("showFittedCurves");
  if (showFitCb) {
    showFitCb.addEventListener("change", () => setShowFittedCurves(showFitCb.checked));
  }
  initPaletteEditor({
    onPaletteChanged(palette) {
      state.editablePalette = palette;
      persistPalette();
    }
  });
  const resetBtn = document.getElementById("paletteResetBtn");
  if (resetBtn) {
    resetBtn.addEventListener("click", async () => {
      if (!confirm("Reset palette? Your color mappings will be lost.")) return;
      state.editablePalette = null;
      state.paletteEntries = null;
      state.bwCounts = null;
      clearPaletteEditor();
      if (state.currentFileId) {
        try {
          await deletePalette(state.currentFileId);
        } catch {
        }
      }
      await runProjectPalette();
    });
  }
  const denoiseBtn = document.getElementById("denoiseBtn");
  denoiseBtn.addEventListener("click", runDenoise);
  const cropBtn = document.getElementById("cropBtn");
  cropBtn.addEventListener("click", enterCropMode);
  const doneCroppingBtn = document.getElementById("doneCroppingBtn");
  if (doneCroppingBtn) doneCroppingBtn.addEventListener("click", exitCropMode);
  const autoCropBtn = document.getElementById("autoCropBtn");
  if (autoCropBtn) autoCropBtn.addEventListener("click", runAutoCropAll);
  const cropLockCheckbox = document.getElementById("cropLockCheckbox");
  if (cropLockCheckbox) {
    cropLockCheckbox.checked = state.cropLocked;
    cropLockCheckbox.addEventListener("change", () => {
      state.cropLocked = cropLockCheckbox.checked;
    });
  }
  initViewer({
    onActivePageChanged,
    onCropChanged(_rect) {
      persistAllCropRects();
      updateCropSizeDisplay();
    },
    onBackToPages() {
      if (document.getElementById("viewerScreen")?.classList.contains("page-picker-active")) {
        showScreen("upload");
      } else if (state.pdfPageCount > 1) {
        setPagePickerMode(true);
      } else {
        showScreen("upload");
      }
    }
  });
  initSteps(() => refreshSidebar());
  initCursorReadout();
  showScreen("upload");
  setStatus("Ready \u2014 drop a PDF to begin");
  globalThis.__cleanplansReady = true;
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
//# sourceMappingURL=bundle.js.map
