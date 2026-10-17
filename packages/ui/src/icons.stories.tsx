import type { Story } from "@ladle/react";
import { AccountIcon, ArrowIcon, AttachIcon, BackIcon, ChatIcon, ChevronIcon, CloseIcon, CrewIcon, DetailsIcon, FileIcon, MachineIcon, MicIcon, NowIcon, PauseIcon, PlayIcon, PlusIcon, SearchIcon, SendIcon, TickIcon } from "./icons.tsx";

export const All: Story = () => (
  <div style={{ display: "flex", gap: 12 }}>
    {[AccountIcon, ArrowIcon, AttachIcon, BackIcon, ChatIcon, ChevronIcon, CloseIcon, CrewIcon, DetailsIcon, FileIcon, MachineIcon, MicIcon, NowIcon, PauseIcon, PlayIcon, PlusIcon, SearchIcon, SendIcon, TickIcon].map((Icon, i) => (
      <Icon key={i} />
    ))}
  </div>
);
