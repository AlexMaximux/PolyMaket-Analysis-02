"use client";

import { useSyncExternalStore } from "react";
import { historyIsCl } from "@/lib/historyDataset";

const subscribe = () => () => {};

/** Original | CL toggle for the analysis pages. A plain link (full page load) so the page reloads its data. */
export function DatasetSwitch({ path }: { path: string }) {
  const cl = useSyncExternalStore(subscribe, historyIsCl, () => false);
  const base = "px-2.5 py-1 rounded-md text-[12px] font-medium border transition-colors";
  const on = "bg-[#d97757]/15 text-[#d97757] border-[#d97757]/40";
  const off = "text-[#9a9ca3] border-transparent hover:text-[#e8e8e4]";
  return (
    <div className="inline-flex flex-col gap-1">
      <div className="inline-flex items-center gap-1 rounded-lg border border-white/[0.12] p-0.5" role="group" aria-label="Dataset">
        <a href={path} className={`${base} ${cl ? off : on}`} title="The records exactly as they were saved">Original</a>
        <a href={`${path}?set=cl`} className={`${base} ${cl ? on : off}`} title="Same snapshots, asked again with the Claude fair value added">CL · + Claude fair value</a>
      </div>
      {cl && (
        <span className="text-[11px] text-[#d97757]">
          CL dataset: the models were asked again with the old fair values plus the Claude 1H fair value. Only records that have answers are listed.
        </span>
      )}
    </div>
  );
}
