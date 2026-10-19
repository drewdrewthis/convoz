import type { Story } from "@ladle/react";
import { Button } from "./Button.tsx";
import { EmptyState } from "./EmptyState.tsx";
import { ChatIcon } from "./icons.tsx";

// One story, so the story book's axe check (every theme, palette and size) stays within its time: the four variants.
export const Variants: Story = () => (
  <div className="flex flex-col">
    <EmptyState>No handoff notes.</EmptyState>
    <EmptyState variant="compact">No agents yet. Connect a machine and add an agent first.</EmptyState>
    <EmptyState variant="note">Type @ to bring in an agent.</EmptyState>
    <EmptyState variant="page" icon={<ChatIcon />} action={<Button variant="primary" href="/chats/new" className="mt-8 min-w-[12rem] w-auto!">New conversation</Button>}>
      No conversations yet. Start one and type @ to bring in an agent.
    </EmptyState>
  </div>
);
