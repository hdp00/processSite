import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";

const RENDER_SCALE = 2;
const MAX_WORKSHEETS = 20;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 100;
const MAX_CELLS = 100_000;
const MAX_SOURCE_SIZE_BYTES = 25 * 1024 * 1024;
const POINTS_PER_INCH = 72;

type Orientation = "portrait" | "landscape";
interface GridRange { startRow: number; endRow: number; startColumn: number; endColumn: number }
interface AxisItem { number: number; size: number }
interface PaperPlan { format: [number, number]; orientation: Orientation; width: number; height: number }
interface PageMargins { top: number; right: number; bottom: number; left: number }
interface WorksheetImage { image: HTMLImageElement; startColumn: number; startRow: number; endColumn: number; endRow: number }
interface WorksheetPlan {
  worksheet: ExcelJS.Worksheet;
  merges: GridRange[];
  images: WorksheetImage[];
  showGridLines: boolean;
  blackAndWhite: boolean;
}
interface PagePlan {
  sheet: WorksheetPlan;
  columns: AxisItem[];
  rows: AxisItem[];
  paper: PaperPlan;
  margins: PageMargins;
  scale: number;
  horizontalCentered: boolean;
  verticalCentered: boolean;
}
interface Rectangle { x: number; y: number; width: number; height: number }

export interface ExcelPdfConversionResult {
  file: File;
  generatedPages: number;
  worksheetCount: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const sumAxis = (items: AxisItem[]) => items.reduce((sum, item) => sum + item.size, 0);
const columnLettersToNumber = (letters: string) => Array.from(letters.toUpperCase()).reduce(
  (result, character) => result * 26 + character.charCodeAt(0) - 64,
  0,
);

const parseCellReference = (reference: string) => {
  const match = reference.replace(/\$/g, "").match(/^([A-Z]+)(\d+)$/i);
  return match ? { column: columnLettersToNumber(match[1]), row: Number(match[2]) } : undefined;
};

const parseGridRange = (value: string): GridRange | undefined => {
  const localRange = value.trim().split("!").pop()?.replace(/'/g, "");
  if (!localRange) return undefined;
  const [first, last = first] = localRange.split(":");
  const start = parseCellReference(first);
  const end = parseCellReference(last);
  return start && end ? {
    startRow: Math.min(start.row, end.row),
    endRow: Math.max(start.row, end.row),
    startColumn: Math.min(start.column, end.column),
    endColumn: Math.max(start.column, end.column),
  } : undefined;
};

const worksheetPrintRanges = (worksheet: ExcelJS.Worksheet) => {
  const configured = worksheet.pageSetup.printArea?.split("&&")
    .map(parseGridRange).filter((range): range is GridRange => Boolean(range));
  if (configured?.length) return configured;
  return [{
    startRow: 1,
    endRow: worksheet.rowCount || worksheet.actualRowCount || 1,
    startColumn: 1,
    endColumn: worksheet.columnCount || worksheet.actualColumnCount || 1,
  }];
};

const parseTitleRows = (value: string | undefined, range: GridRange) => {
  const match = value?.replace(/\$/g, "").match(/(\d+):(\d+)/);
  if (!match) return [];
  const start = Math.max(range.startRow, Number(match[1]));
  const end = Math.min(range.endRow, Number(match[2]));
  return start <= end ? Array.from({ length: end - start + 1 }, (_, index) => start + index) : [];
};

const parseTitleColumns = (value: string | undefined, range: GridRange) => {
  const match = value?.replace(/\$/g, "").match(/([A-Z]+):([A-Z]+)/i);
  if (!match) return [];
  const start = Math.max(range.startColumn, columnLettersToNumber(match[1]));
  const end = Math.min(range.endColumn, columnLettersToNumber(match[2]));
  return start <= end ? Array.from({ length: end - start + 1 }, (_, index) => start + index) : [];
};

const columnWidthPoints = (worksheet: ExcelJS.Worksheet, columnNumber: number) => {
  const width = worksheet.getColumn(columnNumber).width ?? 8.43;
  return Math.max(1, Math.floor(((256 * width + Math.floor(128 / 7)) / 256) * 7) * 0.75);
};

const rowHeightPoints = (worksheet: ExcelJS.Worksheet, rowNumber: number) => Math.max(
  1,
  worksheet.getRow(rowNumber).height ?? worksheet.properties.defaultRowHeight ?? 15,
);

const visibleColumns = (worksheet: ExcelJS.Worksheet, range: GridRange) => Array.from(
  { length: range.endColumn - range.startColumn + 1 }, (_, index) => range.startColumn + index,
).filter((number) => !worksheet.getColumn(number).hidden).map((number) => ({ number, size: columnWidthPoints(worksheet, number) }));

const visibleRows = (worksheet: ExcelJS.Worksheet, range: GridRange) => Array.from(
  { length: range.endRow - range.startRow + 1 }, (_, index) => range.startRow + index,
).filter((number) => !worksheet.getRow(number).hidden).map((number) => ({ number, size: rowHeightPoints(worksheet, number) }));

const paperPlan = (paperSize: number | undefined, orientation: Orientation): PaperPlan => {
  const formats: Record<number, [number, number]> = {
    1: [612, 792], 5: [612, 1008], 7: [522, 756], 8: [841.89, 1190.55], 9: [595.28, 841.89],
    11: [419.53, 595.28], 13: [515.91, 728.5], 119: [558.43, 773.86],
  };
  const format = formats[paperSize ?? 1] ?? formats[9];
  return {
    format,
    orientation,
    width: orientation === "landscape" ? format[1] : format[0],
    height: orientation === "landscape" ? format[0] : format[1],
  };
};

const pageMargins = (worksheet: ExcelJS.Worksheet): PageMargins => {
  const margins = worksheet.pageSetup.margins;
  return {
    left: (margins?.left ?? 0.7) * POINTS_PER_INCH,
    right: (margins?.right ?? 0.7) * POINTS_PER_INCH,
    top: (margins?.top ?? 0.75) * POINTS_PER_INCH,
    bottom: (margins?.bottom ?? 0.75) * POINTS_PER_INCH,
  };
};

const parseMerges = (worksheet: ExcelJS.Worksheet) => (worksheet.model.merges ?? [])
  .map(parseGridRange).filter((range): range is GridRange => Boolean(range));

const overlaps = (left: GridRange, right: GridRange) => left.startRow <= right.endRow && left.endRow >= right.startRow
  && left.startColumn <= right.endColumn && left.endColumn >= right.startColumn;

const splitAxis = (
  bodyItems: AxisItem[], repeatedItems: AxisItem[], availableSize: number, scale: number,
  merges: GridRange[], direction: "row" | "column",
) => {
  const repeated = new Set(repeatedItems.map((item) => item.number));
  const items = bodyItems.filter((item) => !repeated.has(item.number));
  if (!items.length) return [repeatedItems];
  const capacity = Math.max(1, availableSize / scale - sumAxis(repeatedItems));
  const groups: AxisItem[][] = [];
  let current: AxisItem[] = [];
  let size = 0;
  let protectedThrough = 0;
  items.forEach((item) => {
    if (current.length && size + item.size > capacity && item.number > protectedThrough) {
      groups.push([...repeatedItems, ...current]);
      current = [];
      size = 0;
      protectedThrough = 0;
    }
    current.push(item);
    size += item.size;
    merges.forEach((merge) => {
      const start = direction === "row" ? merge.startRow : merge.startColumn;
      const end = direction === "row" ? merge.endRow : merge.endColumn;
      if (item.number >= start && item.number <= end) protectedThrough = Math.max(protectedThrough, end);
    });
  });
  if (current.length) groups.push([...repeatedItems, ...current]);
  return groups;
};

const printScale = (worksheet: ExcelJS.Worksheet, columns: AxisItem[], rows: AxisItem[], width: number, height: number) => {
  const setup = worksheet.pageSetup;
  if (!setup.fitToPage) return clamp((setup.scale || 100) / 100, 0.1, 4);
  const fitToWidth = setup.fitToWidth ?? 0;
  const fitToHeight = setup.fitToHeight ?? 0;
  const widthScale = fitToWidth > 0 ? (width * fitToWidth) / Math.max(1, sumAxis(columns)) : Number.POSITIVE_INFINITY;
  const heightScale = fitToHeight > 0 ? (height * fitToHeight) / Math.max(1, sumAxis(rows)) : Number.POSITIVE_INFINITY;
  const fitted = Math.min(widthScale, heightScale);
  return clamp(Number.isFinite(fitted) ? fitted : 1, 0.1, 4);
};

const loadBrowserImage = (source: string) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error("工作表图片读取失败"));
  image.src = source;
});

const loadWorksheetImages = async (workbook: ExcelJS.Workbook, worksheet: ExcelJS.Worksheet) => {
  const result: WorksheetImage[] = [];
  const seen = new Set<string>();
  for (const placement of worksheet.getImages()) {
    const key = [placement.imageId, placement.range.tl.col, placement.range.tl.row, placement.range.br.col, placement.range.br.row].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const media = workbook.getImage(Number(placement.imageId));
    if (!media || (!media.base64 && !media.buffer)) continue;
    let objectUrl: string | undefined;
    try {
      const source = media.base64 ?? (() => {
        const sourceBytes = media.buffer as unknown as Uint8Array;
        const bytes = new Uint8Array(sourceBytes.byteLength);
        bytes.set(sourceBytes);
        const type = media.extension === "jpeg" ? "image/jpeg" : `image/${media.extension}`;
        objectUrl = URL.createObjectURL(new Blob([bytes.buffer], { type }));
        return objectUrl;
      })();
      result.push({
        image: await loadBrowserImage(source),
        startColumn: placement.range.tl.col,
        startRow: placement.range.tl.row,
        endColumn: placement.range.br.col,
        endRow: placement.range.br.row,
      });
    } catch {
      // ExcelJS may expose image formats that the current browser cannot decode.
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }
  return result;
};

const createPagePlans = async (workbook: ExcelJS.Workbook, worksheet: ExcelJS.Worksheet) => {
  const orientation = worksheet.pageSetup.orientation ?? "portrait";
  const paper = paperPlan(worksheet.pageSetup.paperSize, orientation);
  const margins = pageMargins(worksheet);
  const availableWidth = Math.max(1, paper.width - margins.left - margins.right);
  const availableHeight = Math.max(1, paper.height - margins.top - margins.bottom);
  const allMerges = parseMerges(worksheet);
  const images = await loadWorksheetImages(workbook, worksheet);
  const plans: PagePlan[] = [];
  worksheetPrintRanges(worksheet).forEach((range) => {
    const columns = visibleColumns(worksheet, range);
    const rows = visibleRows(worksheet, range);
    if (!columns.length || !rows.length) return;
    const merges = allMerges.filter((merge) => overlaps(merge, range));
    const scale = printScale(worksheet, columns, rows, availableWidth, availableHeight);
    const titleColumns = new Set(parseTitleColumns(worksheet.pageSetup.printTitlesColumn, range));
    const titleRows = new Set(parseTitleRows(worksheet.pageSetup.printTitlesRow, range));
    const columnGroups = splitAxis(columns, columns.filter((item) => titleColumns.has(item.number)), availableWidth, scale, merges, "column");
    const rowGroups = splitAxis(rows, rows.filter((item) => titleRows.has(item.number)), availableHeight, scale, merges, "row");
    const sheet: WorksheetPlan = {
      worksheet,
      merges,
      images,
      showGridLines: worksheet.pageSetup.showGridLines ?? false,
      blackAndWhite: worksheet.pageSetup.blackAndWhite ?? false,
    };
    const add = (pageColumns: AxisItem[], pageRows: AxisItem[]) => plans.push({
      sheet, columns: pageColumns, rows: pageRows, paper, margins, scale,
      horizontalCentered: worksheet.pageSetup.horizontalCentered ?? false,
      verticalCentered: worksheet.pageSetup.verticalCentered ?? false,
    });
    if (worksheet.pageSetup.pageOrder === "overThenDown") rowGroups.forEach((pageRows) => columnGroups.forEach((pageColumns) => add(pageColumns, pageRows)));
    else columnGroups.forEach((pageColumns) => rowGroups.forEach((pageRows) => add(pageColumns, pageRows)));
  });
  return plans;
};

const indexedColors: Record<number, string> = {
  0: "#000000", 1: "#ffffff", 2: "#ff0000", 3: "#00ff00", 4: "#0000ff", 5: "#ffff00", 6: "#ff00ff", 7: "#00ffff",
  8: "#000000", 9: "#ffffff", 10: "#ff0000", 11: "#00ff00", 12: "#0000ff", 13: "#ffff00", 14: "#ff00ff", 15: "#00ffff", 64: "#000000",
};
const themeColors: Record<number, string> = {
  0: "#ffffff", 1: "#000000", 2: "#e7e6e6", 3: "#44546a", 4: "#4472c4",
  5: "#ed7d31", 6: "#a5a5a5", 7: "#ffc000", 8: "#5b9bd5", 9: "#70ad47",
};

const excelColor = (color: (Partial<ExcelJS.Color> & { indexed?: number }) | undefined, fallback: string) => {
  if (color?.argb && /^[0-9a-f]{8}$/i.test(color.argb)) return `#${color.argb.slice(2)}`;
  if (typeof color?.indexed === "number") return indexedColors[color.indexed] ?? fallback;
  if (typeof color?.theme === "number") return themeColors[color.theme] ?? fallback;
  return fallback;
};

const formatDate = (value: Date, includeTime = false) => {
  const date = new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  if (!includeTime) return date;
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(value);
  return `${date} ${time}`;
};

const cellText = (cell: ExcelJS.Cell) => {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatDate(value, /[hHsS]/.test(cell.numFmt ?? ""));
  if (typeof value === "object") {
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("formula" in value || "sharedFormula" in value) {
      const result = value.result;
      return result instanceof Date ? formatDate(result, /[hHsS]/.test(cell.numFmt ?? "")) : result === undefined || result === null ? "" : String(result);
    }
    if ("hyperlink" in value) return value.text;
    if ("error" in value) return value.error;
  }
  if (typeof value === "number" && /%/.test(cell.numFmt ?? "")) {
    const decimals = cell.numFmt?.match(/0\.(0+)%/)?.[1].length ?? 0;
    return `${(value * 100).toFixed(decimals)}%`;
  }
  return cell.text;
};

const cellFill = (cell: ExcelJS.Cell, blackAndWhite: boolean) => {
  if (blackAndWhite) return "#ffffff";
  const fill = cell.fill;
  return fill?.type === "pattern" && fill.pattern !== "none" ? excelColor(fill.fgColor, "#ffffff") : "#ffffff";
};

const wrappedLines = (context: CanvasRenderingContext2D, text: string, maxWidth: number, wrap: boolean) => {
  const paragraphs = text.replace(/\r\n?/g, "\n").split("\n");
  if (!wrap) return paragraphs.slice(0, 1);
  const lines: string[] = [];
  paragraphs.forEach((paragraph) => {
    if (!paragraph) { lines.push(""); return; }
    let line = "";
    Array.from(paragraph).forEach((character) => {
      const next = `${line}${character}`;
      if (line && context.measureText(next).width > maxWidth) { lines.push(line); line = character; }
      else line = next;
    });
    lines.push(line);
  });
  return lines;
};

const borderWidth = (style: ExcelJS.BorderStyle | undefined) => {
  if (!style) return 0;
  if (["medium", "mediumDashed", "mediumDashDot", "mediumDashDotDot", "slantDashDot"].includes(style)) return 1.5;
  if (["thick", "double"].includes(style)) return 2.25;
  if (["hair", "dotted"].includes(style)) return 0.5;
  return 0.8;
};
const borderDash = (style: ExcelJS.BorderStyle | undefined) => !style || !/dash|dot/i.test(style)
  ? [] : /dot/i.test(style) && !/dash/i.test(style) ? [1, 2] : /dashdot/i.test(style) ? [5, 2, 1, 2] : [5, 3];

const drawBorder = (
  context: CanvasRenderingContext2D, border: Partial<ExcelJS.Border> | undefined,
  x1: number, y1: number, x2: number, y2: number, blackAndWhite: boolean,
) => {
  const width = borderWidth(border?.style);
  if (!width) return;
  context.save();
  context.strokeStyle = blackAndWhite ? "#000000" : excelColor(border?.color, "#202020");
  context.lineWidth = width;
  context.setLineDash(borderDash(border?.style));
  context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2); context.stroke(); context.restore();
};

const drawBorders = (
  context: CanvasRenderingContext2D, rectangle: Rectangle,
  cells: { top: ExcelJS.Cell; right: ExcelJS.Cell; bottom: ExcelJS.Cell; left: ExcelJS.Cell },
  grid: boolean, blackAndWhite: boolean,
) => {
  const { x, y, width, height } = rectangle;
  const sides = [cells.top.border?.top, cells.right.border?.right, cells.bottom.border?.bottom, cells.left.border?.left];
  if (grid && !sides.some((side) => side?.style)) {
    context.strokeStyle = "#d9d9d9"; context.lineWidth = 0.5; context.strokeRect(x, y, width, height);
  }
  drawBorder(context, sides[0], x, y, x + width, y, blackAndWhite);
  drawBorder(context, sides[1], x + width, y, x + width, y + height, blackAndWhite);
  drawBorder(context, sides[2], x, y + height, x + width, y + height, blackAndWhite);
  drawBorder(context, sides[3], x, y, x, y + height, blackAndWhite);
};

const drawText = (
  context: CanvasRenderingContext2D,
  cell: ExcelJS.Cell,
  rectangle: Rectangle,
  blackAndWhite: boolean,
  printScaleValue: number,
) => {
  const text = cellText(cell);
  if (!text) return;
  const font = cell.font;
  let fontSize = clamp(Number(font?.size ?? 10) * printScaleValue, 4, 72);
  const family = (font?.name || "Microsoft YaHei").replace(/["']/g, "");
  const setFont = () => { context.font = `${font?.italic ? "italic " : ""}${font?.bold ? "700" : "400"} ${fontSize}px "${family}", "Microsoft YaHei", Arial, sans-serif`; };
  setFont();
  const padding = Math.max(1.5, (3 + (cell.alignment?.indent ?? 0) * 3) * printScaleValue);
  const availableWidth = Math.max(1, rectangle.width - padding * 2);
  if (cell.alignment?.shrinkToFit) while (fontSize > 4 && context.measureText(text).width > availableWidth) { fontSize -= 0.5; setFont(); }
  const lineHeight = fontSize * 1.25;
  const lines = wrappedLines(context, text, availableWidth, Boolean(cell.alignment?.wrapText));
  const visible = lines.slice(0, Math.max(1, Math.floor((rectangle.height - padding * 2) / lineHeight)));
  const vertical = cell.alignment?.vertical;
  const contentHeight = visible.length * lineHeight;
  const startY = vertical === "top" ? rectangle.y + padding + lineHeight / 2
    : vertical === "bottom" ? rectangle.y + rectangle.height - padding - contentHeight + lineHeight / 2
      : rectangle.y + (rectangle.height - contentHeight) / 2 + lineHeight / 2;
  const horizontal = cell.alignment?.horizontal;
  context.textAlign = horizontal === "right" ? "right" : horizontal === "center" || horizontal === "centerContinuous" ? "center" : "left";
  const textX = context.textAlign === "right" ? rectangle.x + rectangle.width - padding
    : context.textAlign === "center" ? rectangle.x + rectangle.width / 2 : rectangle.x + padding;
  context.fillStyle = blackAndWhite ? "#000000" : excelColor(font?.color, "#202020");
  context.textBaseline = "middle";
  context.save(); context.beginPath(); context.rect(rectangle.x + 0.5, rectangle.y + 0.5, Math.max(0, rectangle.width - 1), Math.max(0, rectangle.height - 1)); context.clip();
  const rotation = typeof cell.alignment?.textRotation === "number" ? cell.alignment.textRotation : 0;
  if (rotation) {
    context.translate(rectangle.x + rectangle.width / 2, rectangle.y + rectangle.height / 2);
    context.rotate((-rotation * Math.PI) / 180); context.textAlign = "center";
    visible.forEach((line, index) => context.fillText(line, 0, (index - (visible.length - 1) / 2) * lineHeight));
  } else visible.forEach((line, index) => context.fillText(line, textX, startY + index * lineHeight));
  context.restore();
};

const axisPositions = (items: AxisItem[], start: number, scale: number) => {
  const positions = new Map<number, { start: number; size: number }>();
  let cursor = start;
  items.forEach((item) => { positions.set(item.number, { start: cursor, size: item.size * scale }); cursor += item.size * scale; });
  return positions;
};

const mergeAt = (merges: GridRange[], row: number, column: number) => merges.find((merge) => row >= merge.startRow
  && row <= merge.endRow && column >= merge.startColumn && column <= merge.endColumn);

const mergedRectangle = (merge: GridRange, rows: Map<number, { start: number; size: number }>, columns: Map<number, { start: number; size: number }>) => {
  const rowParts = [...rows].filter(([number]) => number >= merge.startRow && number <= merge.endRow).map(([, part]) => part);
  const columnParts = [...columns].filter(([number]) => number >= merge.startColumn && number <= merge.endColumn).map(([, part]) => part);
  if (!rowParts.length || !columnParts.length) return undefined;
  return {
    x: Math.min(...columnParts.map((part) => part.start)), y: Math.min(...rowParts.map((part) => part.start)),
    width: columnParts.reduce((sum, part) => sum + part.size, 0), height: rowParts.reduce((sum, part) => sum + part.size, 0),
  };
};

const imagePosition = (items: AxisItem[], positions: Map<number, { start: number; size: number }>, anchor: number) => {
  const index = Math.floor(anchor);
  const item = items.find((candidate) => candidate.number === index + 1);
  const position = item ? positions.get(item.number) : undefined;
  return item && position ? position.start + position.size * (anchor - index) : undefined;
};

const drawImages = (context: CanvasRenderingContext2D, plan: PagePlan, rows: Map<number, { start: number; size: number }>, columns: Map<number, { start: number; size: number }>) => {
  plan.sheet.images.forEach((item) => {
    const x1 = imagePosition(plan.columns, columns, item.startColumn);
    const y1 = imagePosition(plan.rows, rows, item.startRow);
    const x2 = imagePosition(plan.columns, columns, item.endColumn);
    const y2 = imagePosition(plan.rows, rows, item.endRow);
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return;
    context.drawImage(item.image, x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
  });
};

const drawPage = (plan: PagePlan) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(plan.paper.width * RENDER_SCALE); canvas.height = Math.round(plan.paper.height * RENDER_SCALE);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("当前浏览器无法创建 PDF 绘图画布");
  context.scale(RENDER_SCALE, RENDER_SCALE); context.fillStyle = "#ffffff"; context.fillRect(0, 0, plan.paper.width, plan.paper.height);
  const availableWidth = plan.paper.width - plan.margins.left - plan.margins.right;
  const availableHeight = plan.paper.height - plan.margins.top - plan.margins.bottom;
  const tableWidth = sumAxis(plan.columns) * plan.scale;
  const tableHeight = sumAxis(plan.rows) * plan.scale;
  const startX = plan.margins.left + (plan.horizontalCentered ? Math.max(0, (availableWidth - tableWidth) / 2) : 0);
  const startY = plan.margins.top + (plan.verticalCentered ? Math.max(0, (availableHeight - tableHeight) / 2) : 0);
  const rows = axisPositions(plan.rows, startY, plan.scale);
  const columns = axisPositions(plan.columns, startX, plan.scale);
  const drawnMerges = new Set<string>();
  plan.rows.forEach((row) => plan.columns.forEach((column) => {
    const merge = mergeAt(plan.sheet.merges, row.number, column.number);
    if (merge) {
      const key = `${merge.startRow}:${merge.startColumn}:${merge.endRow}:${merge.endColumn}`;
      if (drawnMerges.has(key)) return;
      drawnMerges.add(key);
      const rectangle = mergedRectangle(merge, rows, columns);
      if (!rectangle) return;
      const master = plan.sheet.worksheet.getCell(merge.startRow, merge.startColumn);
      context.fillStyle = cellFill(master, plan.sheet.blackAndWhite); context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
      drawText(context, master, rectangle, plan.sheet.blackAndWhite, plan.scale);
      drawBorders(context, rectangle, {
        top: plan.sheet.worksheet.getCell(merge.startRow, merge.startColumn), right: plan.sheet.worksheet.getCell(merge.startRow, merge.endColumn),
        bottom: plan.sheet.worksheet.getCell(merge.endRow, merge.startColumn), left: plan.sheet.worksheet.getCell(merge.startRow, merge.startColumn),
      }, plan.sheet.showGridLines, plan.sheet.blackAndWhite);
      return;
    }
    const rowPosition = rows.get(row.number)!;
    const columnPosition = columns.get(column.number)!;
    const rectangle = { x: columnPosition.start, y: rowPosition.start, width: columnPosition.size, height: rowPosition.size };
    const cell = plan.sheet.worksheet.getCell(row.number, column.number);
    context.fillStyle = cellFill(cell, plan.sheet.blackAndWhite); context.fillRect(rectangle.x, rectangle.y, rectangle.width, rectangle.height);
    drawText(context, cell, rectangle, plan.sheet.blackAndWhite, plan.scale);
    drawBorders(context, rectangle, { top: cell, right: cell, bottom: cell, left: cell }, plan.sheet.showGridLines, plan.sheet.blackAndWhite);
  }));
  drawImages(context, plan, rows, columns);
  return canvas;
};

const safePdfName = (sourceName: string) => {
  const baseName = sourceName.replace(/\.xlsx$/i, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return `${baseName || "Excel转换结果"}.pdf`;
};

export async function convertXlsxToPdf(sourceFile: File, maxPages: number): Promise<ExcelPdfConversionResult> {
  if (!sourceFile.name.toLowerCase().endsWith(".xlsx")) throw new Error("当前仅支持转换 .xlsx 文件");
  if (sourceFile.size > MAX_SOURCE_SIZE_BYTES) throw new Error("用于浏览器转换的 .xlsx 文件不能超过 25 MB");
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(await sourceFile.arrayBuffer()); }
  catch { throw new Error("无法读取 Excel 文件，请确认文件未损坏、未加密且格式为 .xlsx"); }
  const worksheets = workbook.worksheets.filter((worksheet) => worksheet.state === "visible");
  if (!worksheets.length) throw new Error("Excel 文件中没有可见工作表");
  if (worksheets.length > MAX_WORKSHEETS) throw new Error(`Excel 文件最多支持 ${MAX_WORKSHEETS} 个可见工作表`);
  const totalRows = worksheets.reduce((sum, worksheet) => sum + worksheet.actualRowCount, 0);
  const maximumColumns = Math.max(...worksheets.map((worksheet) => worksheet.actualColumnCount));
  const totalCells = worksheets.reduce((sum, worksheet) => sum + worksheet.actualRowCount * worksheet.actualColumnCount, 0);
  const printRanges = worksheets.flatMap(worksheetPrintRanges);
  const printedRows = printRanges.reduce((sum, range) => sum + range.endRow - range.startRow + 1, 0);
  const printedColumns = Math.max(...printRanges.map((range) => range.endColumn - range.startColumn + 1));
  const printedCells = printRanges.reduce(
    (sum, range) => sum + (range.endRow - range.startRow + 1) * (range.endColumn - range.startColumn + 1),
    0,
  );
  if (totalRows > MAX_ROWS || maximumColumns > MAX_COLUMNS || totalCells > MAX_CELLS
    || printedRows > MAX_ROWS || printedColumns > MAX_COLUMNS || printedCells > MAX_CELLS) {
    throw new Error(`Excel 内容过大，最多支持 ${MAX_ROWS} 行、${MAX_COLUMNS} 列且总计不超过 ${MAX_CELLS} 个单元格`);
  }
  const allPlans = (await Promise.all(worksheets.map((worksheet) => createPagePlans(workbook, worksheet)))).flat();
  const plans = allPlans.slice(0, clamp(Math.floor(maxPages) || 1, 1, 50));
  if (!plans.length) throw new Error("Excel 文件中没有可转换的单元格内容");
  const first = plans[0];
  const pdf = new jsPDF({ orientation: first.paper.orientation, unit: "pt", format: first.paper.format, compress: true });
  plans.forEach((plan, index) => {
    if (index > 0) pdf.addPage(plan.paper.format, plan.paper.orientation);
    const canvas = drawPage(plan);
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.94), "JPEG", 0, 0, plan.paper.width, plan.paper.height, undefined, "FAST");
  });
  const blob = pdf.output("blob");
  const fileName = safePdfName(sourceFile.name);
  return {
    file: new File([blob], fileName, { type: "application/pdf", lastModified: Date.now() }),
    generatedPages: plans.length,
    worksheetCount: worksheets.length,
  };
}
