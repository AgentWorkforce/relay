"""Finder layout for dmgbuild. Coordinates match render-dmg-background.swift."""
import os

application = defines["app"]
app_name = os.path.basename(application)
format = "UDZO"
filesystem = "HFS+"
files = [application]
symlinks = {"Applications": "/Applications"}
background = defines["background"]
# Finder includes its 32-point title bar in these bounds.
window_rect = ((160, 160), (768, 608))
icon_locations = {app_name: (220, 252), "Applications": (548, 252)}
icon_size = 160
text_size = 13
label_pos = "bottom"
default_view = "icon-view"
arrange_by = None
grid_spacing = 80
show_icon_preview = False
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
include_icon_view_settings = True
include_list_view_settings = False
