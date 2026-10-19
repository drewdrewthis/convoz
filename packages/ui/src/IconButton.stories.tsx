import type { Story } from "@ladle/react";
import { IconButton } from "./IconButton.tsx";
import { AttachIcon, BackIcon, CloseIcon, MicIcon, PhoneIcon, SendIcon } from "./icons.tsx";

export const Quiet: Story = () => (
  <div className="flex gap-8">
    <IconButton label="Back" href="/chats"><BackIcon /></IconButton>
    <IconButton label="Call"><PhoneIcon /></IconButton>
    <IconButton label="Call" disabled><PhoneIcon /></IconButton>
  </div>
);
export const Muted: Story = () => <IconButton label="Attach a file" variant="muted" glyph={18} stroke={2}><AttachIcon /></IconButton>;
export const Float: Story = () => <IconButton label="Close thread" variant="float"><CloseIcon /></IconButton>;
export const Discs: Story = () => (
  <div className="flex gap-8">
    <IconButton label="Send" variant="send" glyph={18} stroke={2}><SendIcon /></IconButton>
    <IconButton label="Send" variant="send" glyph={18} stroke={2} disabled><SendIcon /></IconButton>
    <IconButton label="Record a voice message" variant="soft" glyph={18} stroke={2}><MicIcon /></IconButton>
    <IconButton label="Send voice message" variant="primary" glyph={16} stroke={2}><SendIcon /></IconButton>
  </div>
);
export const Sizes: Story = () => (
  <div className="flex items-center gap-8">
    <IconButton label="Close" variant="bordered" size={32} glyph={16}><CloseIcon /></IconButton>
    <IconButton label="Close" variant="plain" size={36} glyph={16}><CloseIcon /></IconButton>
    <IconButton label="Close" size={28} glyph={12}><CloseIcon /></IconButton>
  </div>
);
