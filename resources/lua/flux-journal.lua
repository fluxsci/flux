-- Flux journal export — PDF path.
--
-- The journal assembler (src/lib/style/journalManuscript.ts) tags the blocks it
-- writes with Word custom styles (`::: {custom-style="Title"}`). pandoc's docx
-- writer maps those to the venue's reference.docx styles natively; its LaTeX
-- writer ignores them. This filter gives the PDF the same layout: one table of
-- style name → LaTeX wrapper, nothing else. All journal LOGIC lives in the
-- shared TypeScript core; this file only typesets.

local function wrap(pre, post)
  return { pre = pre, post = post }
end

local center_title = wrap("\\begin{center}\\fluxtitlefont ", "\\par\\end{center}\\vspace{0.4em}")
local left_title = wrap("\\begin{flushleft}\\fluxtitlefont ", "\\par\\end{flushleft}\\vspace{0.2em}")
local authors_c = wrap("\\begin{center}\\fluxnoindent ", "\\par\\end{center}\\smallskip")
local authors_l = wrap("\\begin{flushleft}\\fluxnoindent ", "\\par\\end{flushleft}\\smallskip")
local block = wrap("\\begin{flushleft}\\fluxnoindent ", "\\par\\end{flushleft}\\smallskip")
local plain = wrap("{\\fluxnoindent ", "\\par}")

local STYLES = {
  ["Title"] = left_title,
  ["Head"] = center_title,
  ["Author"] = authors_l,
  ["Authors"] = authors_c,
  ["Affiliation"] = block,
  ["Affiliations"] = block,
  ["Correspondence"] = block,
  ["Abstract"] = plain,
  ["AbstractSummary"] = plain,
  ["Teaser"] = plain,
  ["Section Label"] = plain,
  ["Acknowledgement"] = plain,
  ["Bibliography"] = wrap("{\\fluxbibliography\\hangindent=2.2em\\hangafter=1 ", "\\par}"),
  ["Referencesandnotes"] = wrap("{\\fluxbibliography\\hangindent=2.2em\\hangafter=1 ", "\\par}"),
  ["Figure"] = wrap("\\begin{center}\\fluxfigure ", "\\par\\end{center}\\nopagebreak[4]"),
  ["Figure Legend"] = wrap("{\\fluxlegend ", "\\par}\\medskip"),
  ["Legend"] = wrap("{\\fluxlegend ", "\\par}\\medskip"),
  ["Highlights"] = plain,
}

-- Centre the title when the venue's preamble asks for it (Science).
function Meta(meta)
  if meta["flux-title-align"] and pandoc.utils.stringify(meta["flux-title-align"]) == "center" then
    STYLES["Title"] = center_title
    STYLES["Author"] = authors_c
  end
  return meta
end

function Div(el)
  if not FORMAT:match("latex") then return nil end
  local name = el.attributes["custom-style"]
  local w = name and STYLES[name]
  if not w then return nil end
  local out = { pandoc.RawBlock("latex", w.pre) }
  for _, b in ipairs(el.content) do table.insert(out, b) end
  table.insert(out, pandoc.RawBlock("latex", w.post))
  return out
end

return {
  { Meta = Meta },
  { Div = Div },
}
