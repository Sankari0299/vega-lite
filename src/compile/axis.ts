import * as log from '../log';

import {AxisOrient} from '../axis';
import {COLUMN, ROW, X, Y, Channel} from '../channel';
import {DateTime, isDateTime, timestamp} from '../datetime';
import {title as fieldDefTitle} from '../fielddef';
import {NOMINAL, ORDINAL, TEMPORAL} from '../type';
import {contains, keys, extend, truncate, Dict} from '../util';
import {VgAxis} from '../vega.schema';

import {numberFormat, timeFormatExpression} from './common';
import {Model} from './model';
import {UnitModel} from './unit';

export function parseAxisComponent(model: Model, axisChannels: Channel[]): Dict<VgAxis> {
  return axisChannels.reduce(function(axis, channel) {
    if (model.axis(channel)) {
      axis[channel] = parseAxis(channel, model);
    }
    return axis;
  }, {} as Dict<VgAxis>);
}

/**
 * Make an inner axis for showing grid for shared axis.
 */
export function parseInnerAxis(channel: Channel, model: Model): VgAxis {
  // TODO: support adding ticks as well

  let def: VgAxis = {
    orient: channel === 'x' ? 'bottom' : 'left',
    scale: model.scaleName(channel),
    grid: true,
    domain: false,
    tick: false,
    label: false
  };

  const axis = model.axis(channel);

  // FIXME: audit if we have checked all relevant properties here.
  ['gridScale', 'tickCount', 'values', 'subdivide', 'zindex'].forEach(function(property) {
    let method: (model: Model, channel: Channel, def:any)=>any;

    const value = (method = exports[property]) ?
                  // calling axis.format, axis.grid, ...
                  method(model, channel, def) :
                  axis[property];
    if (value !== undefined) {
      def[property] = value;
    }
  });

  const props = model.axis(channel).properties || {};

  // For now, only need to add grid properties here because innerAxis is only for rendering grid.
  // TODO: support add other properties for innerAxis
  ['grid'].forEach(function(group) {
    const value = encode[group] ?
      encode[group](model, channel, props[group] || {}, def) :
      props[group];
    if (value !== undefined && keys(value).length > 0) {
      def.encode = def.encode || {};
      def.encode[group] = {update: value};
    }
  });

  return def;
}

export function parseAxis(channel: Channel, model: Model): VgAxis {
  const axis = model.axis(channel);

  let def: VgAxis = {
    scale: model.scaleName(channel)
  };

  // 1.2. Add properties
  [
    // a) properties with special rules (so it has axis[property] methods) -- call rule functions
    'format', 'grid', 'gridScale', 'orient', 'tickSize', 'tickCount',  'title', 'values', 'zindex',
    // b) properties without rules, only produce default values in the schema, or explicit value if specified
    'domain', 'offset', 'subdivide', 'tick', 'tickPadding', 'tickSize', 'tickSizeEnd', 'tickSizeMajor', 'tickSizeMinor', 'titleOffset'
  ].forEach(function(property) {
    let method: (model: Model, channel: Channel, def:any)=>any;

    const value = (method = exports[property]) ?
                  // calling axis.format, axis.grid, ...
                  method(model, channel, def) :
                  axis[property];
    if (value !== undefined) {
      def[property] = value;
    }
  });

  // 2) Add mark property definition groups
  const props = model.axis(channel).properties || {};

  [
    'domain', 'labels', // have special rules
    'grid', 'title', 'tickCount', 'majorTicks', 'minorTicks' // only default values
  ].forEach(function(group) {
    const value = encode[group] ?
      encode[group](model, channel, props[group] || {}, def) :
      props[group];
    if (value !== undefined && keys(value).length > 0) {
      def.encode = def.encode || {};
      def.encode[group] = {update: value};
    }
  });

  return def;
}

export function format(model: Model, channel: Channel) {
  return numberFormat(model.fieldDef(channel), model.axis(channel).format, model.config(), channel);
}

// TODO: we need to refactor this method after we take care of config refactoring
/**
 * Default rules for whether to show a grid should be shown for a channel.
 * If `grid` is unspecified, the default value is `true` for ordinal scales that are not binned
 */
export function gridShow(model: Model, channel: Channel) {
  const grid = model.axis(channel).grid;
  if (grid !== undefined) {
    return grid;
  }

  return !model.hasDiscreteScale(channel) && !model.fieldDef(channel).bin;
}

export function grid(model: Model, channel: Channel) {
  if (channel === ROW || channel === COLUMN) {
    // never apply grid for ROW and COLUMN since we manually create rule-group for them
    return undefined;
  }

  return gridShow(model, channel) && (
    // TODO refactor this cleanly -- essentially the condition below is whether
    // the axis is a shared / union axis.
    (channel === Y || channel === X) && !(model.parent() && model.parent().isFacet())
  );
}

export function gridScale(model: Model, channel: Channel) {
  const gridChannel: Channel = channel === 'x' ? 'y' : 'x';
  if (model.scale(gridChannel)) {
    return model.scaleName(gridChannel);
  }
  return undefined;
}

export function zindex(model: Model, channel: Channel, def: {grid?: boolean}) {
  const z = model.axis(channel).zindex;
  if (z !== undefined) {
    return z;
  }
  if (def.grid) {
    // if grid is true, need to put layer on the back so that grid is behind marks
    return 0;
  }
  return 1; // otherwise return undefined and use Vega's default.
};

export function orient(model: Model, channel: Channel) {
  const orient = model.axis(channel).orient;
  if (orient) {
    return orient;
  }

  switch (channel) {
    case COLUMN:
      // FIXME test and decide
      return AxisOrient.TOP;
    case X:
      return AxisOrient.BOTTOM;
    case ROW:
    case Y:
      return AxisOrient.LEFT;
  }
  /* istanbul ignore next: This should never happen. */
  throw new Error(log.message.INVALID_CHANNEL_FOR_AXIS);
}

export function tickCount(model: Model, channel: Channel) {
  const count = model.axis(channel).tickCount;
  if (count !== undefined) {
    return count;
  }

  // FIXME depends on scale type too
  if (channel === X && !model.fieldDef(channel).bin) {
    // Vega's default tickCount often lead to a lot of label occlusion on X without 90 degree rotation
    return 5;
  }

  return undefined;
}

export function title(model: Model, channel: Channel) {
  const axis = model.axis(channel);
  if (axis.title !== undefined) {
    return axis.title;
  }

  // if not defined, automatically determine axis title from field def
  const fieldTitle = fieldDefTitle(model.fieldDef(channel), model.config());

  let maxLength: number;
  if (axis.titleMaxLength) {
    maxLength = axis.titleMaxLength;
  } else if (channel === X && !model.hasDiscreteScale(X)) {
    const unitModel: UnitModel = model as any; // only unit model has channel x
    // For non-ordinal scale, we know cell size at compile time, we can guess max length
    maxLength = unitModel.width / model.axis(X).characterWidth;
  } else if (channel === Y && !model.hasDiscreteScale(Y)) {
    const unitModel: UnitModel = model as any; // only unit model has channel y
    // For non-ordinal scale, we know cell size at compile time, we can guess max length
    maxLength = unitModel.height / model.axis(Y).characterWidth;
  }

  return maxLength ? truncate(fieldTitle, maxLength) : fieldTitle;
}

export function values(model: Model, channel: Channel) {
  const vals = model.axis(channel).values;
  if (vals && isDateTime(vals[0])) {
    return (vals as DateTime[]).map((dt) => {
      // normalize = true as end user won't put 0 = January
      return timestamp(dt, true);
    });
  }
  return vals;
}

export namespace encode {
  export function domain(model: Model, channel: Channel, domainPropsSpec: any) {
    const axis = model.axis(channel);

    return extend(
      axis.axisColor !== undefined ?
        { stroke: {value: axis.axisColor} } :
        {},
      axis.axisWidth !== undefined ?
        { strokeWidth: {value: axis.axisWidth} } :
        {},
      domainPropsSpec || {}
    );
  }

  export function grid(model: Model, channel: Channel, gridPropsSpec: any) {
    const axis = model.axis(channel);

    return extend(
      axis.gridColor !== undefined ? { stroke: {value: axis.gridColor}} : {},
      axis.gridOpacity !== undefined ? {strokeOpacity: {value: axis.gridOpacity} } : {},
      axis.gridWidth !== undefined ? {strokeWidth : {value: axis.gridWidth} } : {},
      axis.gridDash !== undefined ? {strokeDashOffset : {value: axis.gridDash} } : {},
      gridPropsSpec || {}
    );
  }

  export function labels(model: Model, channel: Channel, labelsSpec: any, def: VgAxis) {
    const fieldDef = model.fieldDef(channel);
    const axis = model.axis(channel);
    const config = model.config();

    if (!axis.label) {
      return extend({
        text: ''
      }, labelsSpec);
    }

    // Text
    if (contains([NOMINAL, ORDINAL], fieldDef.type) && axis.labelMaxLength) {
      // TODO replace this with Vega's labelMaxLength once it is introduced
      labelsSpec = extend({
        text: {
          signal: `truncate(datum.value, ${axis.labelMaxLength})`
        }
      }, labelsSpec || {});
    } else if (fieldDef.type === TEMPORAL) {
      labelsSpec = extend({
        text: {
          signal: timeFormatExpression('datum.value', fieldDef.timeUnit, axis.format, axis.shortTimeLabels, config)
        }
      }, labelsSpec);
    }

    // Label Angle
    if (axis.labelAngle !== undefined) {
      labelsSpec.angle = {value: axis.labelAngle};
    } else {
      // auto rotate for X
      if (channel === X && (contains([NOMINAL, ORDINAL], fieldDef.type) || !!fieldDef.bin || fieldDef.type === TEMPORAL)) {
        labelsSpec.angle = {value: 270};
      }
    }

    if (axis.labelAlign !== undefined) {
      labelsSpec.align = {value: axis.labelAlign};
    } else {
      // Auto set align if rotated
      // TODO: consider other value besides 270, 90
      if (labelsSpec.angle) {
        if (labelsSpec.angle.value === 270) {
          labelsSpec.align = {
            value: def.orient === 'top' ? 'left':
                   (channel === X || channel === COLUMN) ? 'right' :
                   'center'
          };
        } else if (labelsSpec.angle.value === 90) {
          labelsSpec.align = {value: 'center'};
        }
      }
    }

    if (axis.labelBaseline !== undefined) {
      labelsSpec.baseline = {value: axis.labelBaseline};
    } else {
      if (labelsSpec.angle) {
        // Auto set baseline if rotated
        // TODO: consider other value besides 270, 90
        if (labelsSpec.angle.value === 270) {
          labelsSpec.baseline = {value: (channel === X || channel === COLUMN) ? 'middle' : 'bottom'};
        } else if (labelsSpec.angle.value === 90) {
          labelsSpec.baseline = {value: 'bottom'};
        }
      }
    }

    if (axis.tickLabelColor !== undefined) {
        labelsSpec.fill = {value: axis.tickLabelColor};
    }

    if (axis.tickLabelFont !== undefined) {
        labelsSpec.font = {value: axis.tickLabelFont};
    }

    if (axis.tickLabelFontSize !== undefined) {
        labelsSpec.fontSize = {value: axis.tickLabelFontSize};
    }

    return keys(labelsSpec).length === 0 ? undefined : labelsSpec;
  }

  export function ticks(model: Model, channel: Channel, ticksPropsSpec: any) {
    const axis = model.axis(channel);

    return extend(
      axis.tickColor !== undefined ? {stroke : {value: axis.tickColor} } : {},
      axis.tickWidth !== undefined ? {strokeWidth: {value: axis.tickWidth} } : {},
      ticksPropsSpec || {}
    );
  }

  export function title(model: Model, channel: Channel, titlePropsSpec: any) {
    const axis = model.axis(channel);

    return extend(
      axis.titleColor !== undefined ? {fill : {value: axis.titleColor} } : {},
      axis.titleFont !== undefined ? {font: {value: axis.titleFont}} : {},
      axis.titleFontSize !== undefined ? {fontSize: {value: axis.titleFontSize}} : {},
      axis.titleFontWeight !== undefined ? {fontWeight: {value: axis.titleFontWeight}} : {},

      titlePropsSpec || {}
    );
  }
}
