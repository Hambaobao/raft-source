-- Preserve explicit references and completed inputs from the development protocol.
UPDATE messages
SET action_metadata = jsonb_build_object('kind', 'message', 'replyTo', action_metadata->>'messageId')
  || CASE WHEN action_metadata->>'phase' = 'final'
     THEN jsonb_build_object('completedInputMessageIds', jsonb_build_array(action_metadata->>'messageId'))
     ELSE '{}'::jsonb END
WHERE action_metadata->>'kind' = 'reply';
