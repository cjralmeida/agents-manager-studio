-- The homologation tool groups are not Render-specific (they also serve AWS): "render" becomes "hom" and "render_read" becomes "hom_read".
UPDATE "agent_profiles" SET "tools" = array_replace(array_replace("tools", 'render_read', 'hom_read'), 'render', 'hom');
UPDATE "agents" SET "tools" = array_replace(array_replace("tools", 'render_read', 'hom_read'), 'render', 'hom');
