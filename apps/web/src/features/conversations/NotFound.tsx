/** NotFound is the 404 page of a conversation that does not exist or is not the owner's (the server answers it with 404). */
export function NotFound() {
  return (
    <div className="emptystate">
      <p className="lead">This chat does not exist, or it is not yours.</p>
      <a className="btn primary" href="/chats">
        Back to Conversations
      </a>
    </div>
  );
}
