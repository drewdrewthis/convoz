import type { Story } from "@ladle/react";
import { Field } from "./Field.tsx";
import { List } from "./ListRow.tsx";

export const Plain: Story = () => <Field label="Agent handle" />;
export const WithHint: Story = () => <Field label="Agent handle" hint="2 to 40 characters from a-z, 0-9 and -." />;
// One story for the fields that are not a plain text field, so the story book's axe check (every theme, palette and size) stays within its time.
export const Choices: Story = () => (
  <div className="flex flex-col">
    <Field label="Recovery code" mono />
    <List as="div" aria-label="Switches">
      <Field type="checkbox" label="Push on this device" role="switch" />
      <Field type="checkbox" label="Let urgent asks through" role="switch" defaultChecked />
    </List>
    <List as="div" role="radiogroup" aria-label="Previews">
      <Field type="radio" name="previews" label="Sender and text" defaultChecked />
      <Field type="radio" name="previews" label="Sender only" />
    </List>
    <List as="div" aria-label="Quiet hours">
      <Field type="time" label="From" defaultValue="22:00" />
      <Field type="time" label="Until" defaultValue="07:00" />
    </List>
    <List aria-label="Reasons">
      <Field as="li" type="checkbox" role="switch" label="Mentions" />
      <Field as="li" type="checkbox" role="switch" label="Thread replies" defaultChecked />
    </List>
    <Field as="check" type="checkbox" label="I saved them" />
  </div>
);
