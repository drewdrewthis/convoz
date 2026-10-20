import type { Story } from "@ladle/react";
import { Button } from "./Button.tsx";

export const Plain: Story = () => <Button>Mark all read</Button>;
export const Primary: Story = () => <Button variant="primary">Approve</Button>;
export const Quiet: Story = () => <Button variant="quiet">Not now</Button>;
export const Danger: Story = () => <Button variant="danger">Delete</Button>;
export const Small: Story = () => (
  <div className="flex gap-8">
    <Button size="small">Restore</Button>
    <Button size="small" variant="quiet">Earlier</Button>
    <Button size="small" variant="danger">Hang up</Button>
  </div>
);
export const Disabled: Story = () => <Button variant="primary" disabled>Send</Button>;
export const Busy: Story = () => <Button variant="primary" aria-busy="true">Saving</Button>;
export const AsLink: Story = () => <Button variant="primary" href="/chats/new">New conversation</Button>;
export const Pills: Story = () => (
  <div className="flex flex-col gap-8">
    <div className="flex">
      <Button variant="text" size="inline">Quick reply</Button>
      <Button variant="primary" size="inline">Send</Button>
      <Button variant="muted" size="chip" aria-expanded="false">Snoozed</Button>
    </div>
    <Button size="option" variant="primary">Merge it</Button>
    <Button size="option">Hold it</Button>
    <Button size="option" variant="dashed">Reply in thread</Button>
  </div>
);
