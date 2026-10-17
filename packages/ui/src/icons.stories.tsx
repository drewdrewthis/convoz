import type { Story } from "@ladle/react";
import { AccountIcon, BackIcon, ChatIcon, CrewIcon, DetailsIcon, MachineIcon, NowIcon, PlusIcon, SearchIcon, SendIcon, TickIcon } from "./icons.tsx";

export const All: Story = () => (
  <div style={{ display: "flex", gap: 12 }}>
    {[AccountIcon, BackIcon, ChatIcon, CrewIcon, DetailsIcon, MachineIcon, NowIcon, PlusIcon, SearchIcon, SendIcon, TickIcon].map((Icon, i) => (
      <Icon key={i} />
    ))}
  </div>
);
