"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FlaskConical, Play, Square } from "lucide-react";
import type { CurveRow } from "@/lib/jevCurves";
import type { AnalysisConfig } from "@/lib/signalAnalysis";
import { createLabSplit, optimizeLab, runLab, type LabCandidate, type LabObjective, type LabRange, type LabSplit } from "@/lib/jevLab";
import styles from "./CurveOptimizer.module.css";

interface ScoreGrid {
  bullishScore: LabRange;
  bearishScore: LabRange;
  confidence: LabRange;
  minimumTrainResolved: number;
  trainFraction: number;
  objective: LabObjective;
}

interface SearchResult {
  candidates: LabCandidate[];
  split: LabSplit;
  evaluated: number;
  context: string;
  dataRevision: string;
}

const INITIAL_GRID: ScoreGrid = {
  bullishScore: { min: 3.25, max: 3.75, step: 0.25 },
  bearishScore: { min: 0.25, max: 0.75, step: 0.25 },
  confidence: { min: 80, max: 95, step: 5 },
  minimumTrainResolved: 20,
  trainFraction: 0.7,
  objective: "pnl",
};

const RANGE_LABELS = {
  bullishScore: "آستانهٔ امتیاز UP",
  bearishScore: "آستانهٔ امتیاز DOWN",
  confidence: "حداقل اطمینان هر دو جهت · %",
} as const;
const PART_LABELS = { min: "از", max: "تا", step: "گام" } as const;
const percent = (value: number | null) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
const money = (value: number) => `${value < 0 ? "−" : value > 0 ? "+" : ""}$${Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function rangeCount(range: LabRange, max: number): number {
  if (![range.min, range.max, range.step].every(Number.isFinite) || range.min < 0 || range.max > max || range.min > range.max || range.step <= 0) return 0;
  const count = Math.floor((range.max - range.min) / range.step + 1e-8) + 1;
  return Number.isSafeInteger(count) ? count : 0;
}

function rangeValues(range: LabRange, max: number): number[] {
  const count = rangeCount(range, max);
  if (count > 400) return [];
  return Array.from({ length: count }, (_, index) => Number((range.min + index * range.step).toFixed(8)));
}

export function CurveOptimizer({ rows, config, onApply, dataRevision }: {
  rows: CurveRow[];
  config: AnalysisConfig;
  onApply: (config: AnalysisConfig) => void;
  dataRevision: string;
}) {
  const [grid, setGrid] = useState<ScoreGrid>(INITIAL_GRID);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const context = JSON.stringify({ config, grid });

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; controllerRef.current?.abort(); };
  }, []);

  const values = useMemo(() => ({
    up: rangeValues(grid.bullishScore, 4),
    down: rangeValues(grid.bearishScore, 4),
    confidence: rangeValues(grid.confidence, 100),
  }), [grid]);
  const combinations = rangeCount(grid.bullishScore, 4) * rangeCount(grid.bearishScore, 4) * rangeCount(grid.confidence, 100);
  const invalid = !combinations
    || !Number.isInteger(grid.minimumTrainResolved) || grid.minimumTrainResolved < 1;
  const stale = !!result && (result.context !== context || result.dataRevision !== dataRevision);
  const scope = useMemo(() => runLab(rows, config), [rows, config]);
  const split = useMemo(() => createLabSplit(scope.rows, grid.trainFraction), [scope.rows, grid.trainFraction]);

  async function runSearch() {
    if (invalid || combinations > 400 || busy) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const searchConfig = structuredClone(config);
    const searchGrid = structuredClone(grid);
    const searchContext = context;
    const searchRevision = dataRevision;
    const candidates: LabCandidate[] = [];
    let completed = 0;
    let sharedSplit = split;
    setBusy(true);
    setProgress(0);
    setMessage("");
    setResult(null);
    try {
      for (const up of values.up) {
        for (const down of values.down) {
          if (controller.signal.aborted) break;
          // Pass the complete scoped history to the shared engine: selecting a zoom
          // interval first would hide earlier signals in the same market hour.
          const part = await optimizeLab(rows, { ...searchConfig, bullishScore: up, bearishScore: down }, {
            confidence: searchGrid.confidence,
            minMinute: { min: searchConfig.minMinute, max: searchConfig.minMinute, step: 1 },
            maxEntry: { min: searchConfig.maxEntry, max: searchConfig.maxEntry, step: 1 },
            minimumTrainResolved: searchGrid.minimumTrainResolved,
            objective: searchGrid.objective,
            trainFraction: searchGrid.trainFraction,
            signal: controller.signal,
            onProgress: (evaluated) => {
              if (alive.current) setProgress(completed + evaluated);
            },
          });
          sharedSplit = part.split;
          if (controller.signal.aborted) break;
          candidates.push(...part.candidates.map(candidate => ({ ...candidate, id: `${up}:${down}:${candidate.id}` })));
          completed += part.evaluated;
          if (alive.current) setProgress(completed);
          // A confidence range of fewer than four entries may not yield inside
          // optimizeLab; yield between score pairs so cancellation remains usable.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
        if (controller.signal.aborted) break;
      }
      if (!alive.current) return;
      if (controller.signal.aborted) {
        setMessage(`جست‌وجو متوقف شد؛ ${completed} ترکیب کامل بررسی شده بود.`);
        return;
      }
      // Holdout values never enter the global ordering or a tie-breaker.
      candidates.sort((a, b) => (b.train[searchGrid.objective] ?? -Infinity) - (a.train[searchGrid.objective] ?? -Infinity)
        || b.train.resolved - a.train.resolved || a.id.localeCompare(b.id));
      setResult({ candidates, split: sharedSplit, evaluated: completed, context: searchContext, dataRevision: searchRevision });
    } catch (error) {
      if (alive.current) setMessage(error instanceof Error ? `جست‌وجو کامل نشد: ${error.message}` : "جست‌وجو کامل نشد؛ بازه‌ها را بررسی کنید.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  function changeRange(key: keyof typeof RANGE_LABELS, part: keyof LabRange, value: number) {
    if (!Number.isFinite(value)) return;
    setGrid(current => ({ ...current, [key]: { ...current[key], [part]: value } }));
  }

  return <section className={styles.optimizer} aria-label="بهینه‌سازی شرط‌های روی منحنی" dir="rtl">
    <div className={styles.heading}>
      <div><h2><FlaskConical size={16} />بهینه‌سازی شرط‌های روی منحنی</h2><p>آستانه‌های امتیاز و اطمینان را جست‌وجو کنید و نتیجه را مستقیم روی نمودار ببینید.</p></div>
      <span className={styles.count}>{combinations.toLocaleString("en-US")} ترکیب / حداکثر ۴۰۰</span>
    </div>

    <div className={styles.scope}>
      <span>{config.coins.join(" / ") || "همهٔ ارزها"}</span><span>مدل {config.model.toUpperCase()}</span>
      <span>دقیقهٔ {config.minMinute}–{config.maxMinute}</span><span>قیمت سهم {config.minEntry}–{config.maxEntry}¢</span>
      <span>{scope.rows.length.toLocaleString("en-US")} اسنپ‌شات در محدوده</span>
      <span>سرمایهٔ هر معامله {money(config.stake).replace("+", "")} · لغزش {config.slippageCents}¢</span>
    </div>

    <div className={styles.searchGrid}>
      <span>پارامتر</span><span>از</span><span>تا</span><span>گام</span>
      {(Object.keys(RANGE_LABELS) as (keyof typeof RANGE_LABELS)[]).map(key => <div key={key} className={styles.rangeRow}>
        <span>{RANGE_LABELS[key]}</span>
        {(["min", "max", "step"] as const).map(part => <input
          key={part} type="number" dir="ltr" disabled={busy} aria-label={`${RANGE_LABELS[key]} · ${PART_LABELS[part]}`}
          min={part === "step" ? 0.01 : 0} max={key === "confidence" ? 100 : 4}
          step={key === "confidence" ? 1 : 0.25} value={grid[key][part]}
          onChange={event => changeRange(key, part, event.target.valueAsNumber)}
        />)}
      </div>)}
    </div>

    <div className={styles.options}>
      <label><span>رتبه‌بندی روی آموزش</span><select disabled={busy} value={grid.objective} onChange={event => setGrid(current => ({ ...current, objective: event.target.value as LabObjective }))}>
        <option value="pnl">سود و زیان خالص</option><option value="roi">بازده سرمایه</option><option value="winRate">نرخ برد</option>
      </select></label>
      <label><span>حداقل معاملات قطعی آموزش</span><input type="number" disabled={busy} min={1} step={1} dir="ltr" value={grid.minimumTrainResolved} onChange={event => {
        const value = event.target.valueAsNumber;
        if (Number.isFinite(value)) setGrid(current => ({ ...current, minimumTrainResolved: value }));
      }} /></label>
      <label><span>تقسیم زمانی</span><select disabled={busy} value={grid.trainFraction} onChange={event => setGrid(current => ({ ...current, trainFraction: Number(event.target.value) }))}>
        <option value={0.6}>۶۰٪ آموزش / ۴۰٪ ارزیابی</option><option value={0.7}>۷۰٪ آموزش / ۳۰٪ ارزیابی</option><option value={0.8}>۸۰٪ آموزش / ۲۰٪ ارزیابی</option>
      </select></label>
    </div>

    <div className={styles.runRow}>
      <p>{split.trainHours} ساعت آموزش و {split.holdoutHours} ساعت ارزیابی؛ بقیهٔ قوانین فعلی ثابت می‌مانند.</p>
      {busy ? <button className={styles.button} onClick={() => controllerRef.current?.abort()}><Square size={13} />توقف جست‌وجو</button>
        : <button className={`${styles.button} ${styles.primary}`} disabled={invalid || combinations > 400 || !scope.rows.length} onClick={() => void runSearch()}><Play size={14} />جست‌وجوی شرط‌ها</button>}
    </div>
    {invalid && <p className={styles.error}>بازه‌ها باید مرتب، گام‌ها مثبت، و حداقل معاملات یک عدد صحیح مثبت باشد.</p>}
    {!invalid && combinations > 400 && <p className={styles.error}>فضای جست‌وجو بیش از ۴۰۰ ترکیب است؛ بازه‌ها را محدودتر یا گام‌ها را بزرگ‌تر کنید.</p>}
    {busy && <div className={styles.progress} role="status"><progress max={combinations || 1} value={progress} /><span dir="ltr">{progress} / {combinations}</span></div>}
    {message && <p className={styles.message} role="status">{message}</p>}

    {result && <div className={styles.results}>
      <div className={styles.resultsHeading}><h3>ترکیب‌های برترِ آموزش</h3><span>{result.evaluated} ترکیب بررسی شد · {Math.min(8, result.candidates.length)} نتیجهٔ برتر</span></div>
      {stale && <p className={styles.error} role="status">داده، قوانین یا فضای جست‌وجو تغییر کرده است. برای اعمال نتیجه روی منحنی، جست‌وجو را دوباره اجرا کنید.</p>}
      {!result.candidates.length ? <p className={styles.empty}>هیچ ترکیبی به حداقل معاملات قطعی آموزش نرسید؛ نمونهٔ بیشتری انتخاب کنید یا حداقل معاملات را کاهش دهید.</p>
        : <div className={styles.tableWrap}><table>
          <thead><tr><th>رتبه</th><th>UP &gt;</th><th>DOWN &lt;</th><th>اطمینان</th><th>معاملات آموزش</th><th>برد آموزش</th><th>سود آموزش</th><th>بازده آموزش</th><th>معاملات ارزیابی</th><th>برد ارزیابی</th><th>سود ارزیابی</th><th>اعمال</th></tr></thead>
          <tbody>{result.candidates.slice(0, 8).map((candidate, index) => <tr key={candidate.id}>
            <td>{index + 1}</td><td>{candidate.config.bullishScore}</td><td>{candidate.config.bearishScore}</td><td>{candidate.config.bullishMinConf}%</td>
            <td>{candidate.train.resolved}</td><td dir="ltr">{percent(candidate.train.winRate)}</td><td dir="ltr">{money(candidate.train.pnl)}</td><td dir="ltr">{percent(candidate.train.roi)}</td>
            <td>{candidate.holdout.resolved}</td><td dir="ltr">{percent(candidate.holdout.winRate)}</td><td dir="ltr" className={candidate.holdout.pnl < 0 ? styles.negative : undefined}>{money(candidate.holdout.pnl)}</td>
            <td><button className={styles.apply} disabled={stale || busy} onClick={() => onApply(structuredClone(candidate.config))}>اعمال روی منحنی <ArrowLeft size={12} /></button></td>
          </tr>)}</tbody>
        </table></div>}
      <p className={styles.note}>ترکیب‌ها فقط با نتیجهٔ آموزش مرتب می‌شوند. {result.split.cutoff && <>ارزیابی از <bdi dir="ltr">{result.split.cutoff}</bdi> ET شروع می‌شود. </>}ساعت‌های یک بازار در دو بخش پخش نمی‌شوند؛ دیدن و تنظیم مکررِ ارزیابی، آن را به دادهٔ دیده‌شده تبدیل می‌کند.</p>
    </div>}
    <p className={styles.note}>حداقل اطمینان هر دو جهت با یک مقدار مشترک تغییر می‌کند. ترکیب ناسازگار با سقف اطمینان فعلی کنار گذاشته می‌شود. معاملات بدون قیمت معتبر از محاسبات مالی حذف می‌شوند؛ این برآورد کارمزد و عمق سفارش را مدل نمی‌کند.</p>
  </section>;
}
