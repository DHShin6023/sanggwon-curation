// 최소 DOM 스텁. jsdom이 이 환경에 설치돼 있지 않아(package.json에 의존성 없음,
// 프로젝트가 외부 런타임 의존성을 두지 않는 방침) render.js/main.js가 실제로
// 쓰는 만큼만 손으로 구현한다: createElement, className, textContent,
// append/replaceChildren, hidden, addEventListener, setAttribute/getAttribute,
// focus. 실제 브라우저 DOM의 부분집합이고 그 이상을 흉내내지 않는다 — 이
// 스텁으로 잡을 수 있는 결함(참조 오류, 잘못된 텍스트/클래스)과 스텁으로 잡을
// 수 없는 것(실제 CSS 렌더링, 진짜 스크린리더 동작)을 구분해서 report에 적을 것.
//
// ⚠️ 리뷰 라운드 2 I4: getElementById가 모르는 id도 조용히 새 노드를
// 만들어주던 버전은 계약을 검증하지 못했다 — index.html에서 요소 하나를
// 지워도(예: <datalist id="industry-options"> 삭제) 테스트는 여전히
// 초록불이었다. 실제 브라우저처럼 모르는 id는 null을 돌려준다. 필요한
// id는 installDom(ids)에 전부 명시해야 하고, 그 목록이 실제로 index.html에
// 있는지는 html-contract.test.js가 별도로 확인한다.

export class FakeNode {
  constructor(tag = "div") {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.className = "";
    this._text = "";
    this.hidden = false;
    this._attrs = new Map();
    this._listeners = new Map();
    this._focused = false;
  }
  set textContent(v) { this._text = v ?? ""; this.children = []; }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; this._text = ""; }
  addEventListener(type, handler) { this._listeners.set(type, handler); }
  async dispatchEvent(type, event) {
    const handler = this._listeners.get(type);
    if (handler) await handler(event);
  }
  setAttribute(name, value) { this._attrs.set(name, String(value)); }
  getAttribute(name) { return this._attrs.has(name) ? this._attrs.get(name) : null; }
  removeAttribute(name) { this._attrs.delete(name); }
  focus() { this._focused = true; }

  // 클래스 이름으로 서브트리를 훑는다(테스트 편의용 — 실제 DOM API는 아니다).
  queryAll(cls) {
    const out = [];
    const walk = (node) => {
      if (node.className && node.className.split(/\s+/).includes(cls)) out.push(node);
      for (const c of node.children) walk(c);
    };
    walk(this);
    return out;
  }
  query(cls) { return this.queryAll(cls)[0] ?? null; }
}

// I5: `<form>` 이름 있는 필드 값을 담아두는 최소 컨테이너. 실제 DOM의
// `form.elements`를 흉내내지 않고, `new FormData(form)`이 읽어갈 원본
// 값만 보관한다 — main.js는 `data.get(name)`만 쓰므로 이걸로 충분하다.
export function setFormValues(formNode, values) {
  formNode._values = values;
}

// I5: Node 내장 FormData는 진짜 HTMLFormElement가 아니면 생성자에서 던진다
// (브랜드 체크) — FakeNode로는 못 쓴다. main.js가 쓰는 표면(`get(name)`)만
// 구현한 최소 대역이다. installDom()이 호출될 때마다 global.FormData를
// 다시 세팅한다.
class FakeFormData {
  constructor(form) {
    this._values = form?._values ?? {};
  }
  get(name) {
    return Object.prototype.hasOwnProperty.call(this._values, name) ? this._values[name] : null;
  }
}

// 테스트 파일마다 독립된 document/전역 상태가 필요해서(특히 main.js처럼
// 모듈 최상단에서 getElementById를 즉시 호출하는 코드), 스텁 설치는 함수로
// 감싸 호출 시점에 새 FakeNode들을 만든다. 반환값의 els에 필요한 만큼
// 미리 채워 넣고 쓴다. ids에 없는 요소를 찾으면(실제 브라우저처럼) null이다.
export function installDom(ids = []) {
  const els = {};
  for (const id of ids) els[id] = new FakeNode(id === "query" ? "form" : "div");
  global.document = {
    getElementById: (id) => els[id] ?? null,
    createElement: (tag) => new FakeNode(tag),
  };
  global.FormData = FakeFormData;
  return els;
}
