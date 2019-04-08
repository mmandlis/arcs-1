import {PolymerElement} from '../deps/@polymer/polymer/polymer-element.js';
import {MessengerMixin} from './arcs-shared.js';
import './common/filter-input.js';
import './common/object-explorer.js';
import {html} from '../deps/@polymer/polymer/lib/utils/html-tag.js';

function nameCompare(x, y) {
  const nameA = x.name.toUpperCase();
  const nameB = y.name.toUpperCase();
  if (nameA < nameB) return -1;
  if (nameA > nameB) return 1;
  return 0;
}

class ArcsEnvironment extends MessengerMixin(PolymerElement) {
  static get template() {
    return html`
    <style include="shared-styles">
      :host {
        line-height: 24px;
      }
      [name] {
        color: var(--devtools-blue);
        margin-left: 1ch;
      }
      [title] {
        padding: 0 8px;
        height: 26px;
        border-bottom: 1px solid var(--mid-gray);
        background-color: var(--light-gray);
      }
      [content] {
        border-bottom: 1px solid var(--mid-gray);
      }
      object-explorer[find]:not([found-inside]) {
        display: none;
      }
    </style>
    <header class="header">
      <div section>
        <filter-input filter="{{searchParams}}"></filter-input>
      </div>
    </header>
    <div title>Recipes</div>
    <div content>
      <template is="dom-repeat" items="{{recipes}}">
        <object-explorer object="{{item}}">
          <span name>[[item.name]]</span>
        </object-explorer>
      </template>
      <template is="dom-if" if="{{!recipes.length}}">
        <div class="empty-label">No recipes</div>
      </template>
    </div>
    <div title>Particles</div>
    <div content>
      <template is="dom-repeat" items="{{particles}}">
        <object-explorer object="{{item}}">
          <span name>[[item.name]]</span>
        </object-explorer>
      </template>
      <template is="dom-if" if="{{!particles.length}}">
        <div class="empty-label">No particles</div>
      </template>
    </div>`;
  }

  constructor() {
    super();
    this.recipes = [];
    this.particles = [];
  }

  static get properties() {
    return {
      searchParams: {
        type: Object,
        observer: '_onSearchChanged'
      }
    };
  }

  _onSearchChanged(params) {
    for (const explorer of this.shadowRoot.querySelectorAll('object-explorer')) {
      explorer.find = params;
    }
  }

  onMessage(msg) {
    switch (msg.messageType) {
      case 'arc-environment':
        this.recipes = msg.messageBody.recipes.slice();
        this.recipes.sort(nameCompare);
        this.particles = msg.messageBody.particles.slice();
        this.particles.sort(nameCompare);
        break;
      case 'arc-selected':
      case 'page-refresh':
        this.recipes = [];
        this.particles = [];
        break;
    }
  }

  static get is() { return 'arcs-environment'; }
}

window.customElements.define(ArcsEnvironment.is, ArcsEnvironment);
