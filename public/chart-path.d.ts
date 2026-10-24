export interface Range { min: number; max: number }
export function linePath(values: ReadonlyArray<number | null>, w: number, h: number, pad: number, xAt?: ReadonlyArray<number>, xRange?: Range | null, domain?: Range | null): string
export function areaPath(d: string, w: number, h: number, pad: number): string
export function hash(s: string): number
export function expandDomain(current: Range | null | undefined, values: ReadonlyArray<number | null>, minSpan?: number): Range | null
export function clampY(value: number, domain: Range | null | undefined, h: number, pad: number): number
