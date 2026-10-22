import type { Story } from "@ladle/react";
import { AccountIcon, AlertIcon, ArrowIcon, AttachIcon, BackIcon, ChatIcon, ChevronIcon, ClockIcon, CloseIcon, CrewIcon, DetailsIcon, DownloadIcon, FileIcon, HandIcon, MachineIcon, MicIcon, NowIcon, PauseIcon, PhoneIcon, PlayIcon, PlusIcon, ReplyIcon, SearchIcon, SendIcon, TickIcon } from "./icons.tsx";

export const All: Story = () => (
  <div style={{ display: "flex", gap: 12 }}>
    {[AccountIcon, AlertIcon, ArrowIcon, AttachIcon, BackIcon, ChatIcon, ChevronIcon, ClockIcon, CloseIcon, CrewIcon, DetailsIcon, DownloadIcon, FileIcon, HandIcon, MachineIcon, MicIcon, NowIcon, PauseIcon, PhoneIcon, PlayIcon, PlusIcon, ReplyIcon, SearchIcon, SendIcon, TickIcon].map((Icon, i) => (
      <Icon key={i} />
    ))}
  </div>
);
